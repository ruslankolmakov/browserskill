#!/usr/bin/env node
/* ffmcp native messaging host.
 *
 * Запускается самим Firefox. С одной стороны — native messaging по stdio
 * (4 байта длины little-endian + JSON), с другой — Unix-сокет, к которому
 * подключаются MCP-серверы. Никаких TCP-портов и HTTP.
 */

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const STATE_DIR = process.env.FFMCP_DIR || path.join(os.homedir(), ".ffmcp");
const SOCKET_PATH = path.join(STATE_DIR, "ffmcp.sock");
const OWNER_PATH = path.join(STATE_DIR, "host.pid");
const LOG_PATH = path.join(STATE_DIR, "host.log");

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

/* ---------- native messaging: чтение stdin ---------- */

let inbox = Buffer.alloc(0);

process.stdin.on("data", (buf) => {
  inbox = Buffer.concat([inbox, buf]);
  for (;;) {
    if (inbox.length < 4) return;
    const len = inbox.readUInt32LE(0);
    if (inbox.length < 4 + len) return;
    const body = inbox.subarray(4, 4 + len);
    inbox = inbox.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (e) {
      log("плохой JSON от расширения:", e.message);
      continue;
    }
    onExtensionMessage(msg);
  }
});

process.stdin.on("end", () => {
  log("Firefox закрыл stdin — выходим");
  cleanup();
  process.exit(0);
});

function sendToExtension(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

/* ---------- маршрутизация вызовов ---------- */

let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }
const chunks = new Map(); // id -> { total, parts: [] }
let extensionReady = false;
const waitingForExtension = [];

function onExtensionMessage(msg) {
  if (msg.type === "hello") {
    extensionReady = true;
    log("расширение подключилось:", msg.extension, "v" + msg.version);
    while (waitingForExtension.length) waitingForExtension.shift()();
    return;
  }

  if (msg.type === "chunk") {
    let acc = chunks.get(msg.id);
    if (!acc) {
      acc = { total: msg.total, parts: new Array(msg.total).fill(null) };
      chunks.set(msg.id, acc);
    }
    acc.parts[msg.seq] = msg.data;
    if (acc.parts.every((p) => p !== null)) {
      chunks.delete(msg.id);
      try {
        onExtensionMessage(JSON.parse(acc.parts.join("")));
      } catch (e) {
        settle(msg.id, { ok: false, error: "не удалось собрать чанки: " + e.message });
      }
    }
    return;
  }

  if (msg.type === "result") settle(msg.id, msg);
}

function settle(id, msg) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  p.resolve(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error });
}

function callExtension(op, params, timeoutMs) {
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: `таймаут операции ${op} (${timeoutMs} мс)` });
    }, timeoutMs);
    pending.set(id, { resolve, timer });

    const dispatch = () => sendToExtension({ type: "call", id, op, params });
    if (extensionReady) dispatch();
    else waitingForExtension.push(dispatch);
  });
}

/* ---------- Unix-сокет для MCP-серверов ---------- */

try {
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
} catch (e) {
  log("не удалось удалить старый сокет:", e.message);
}

const server = net.createServer((sock) => {
  let buf = "";
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch (e) {
        sock.write(JSON.stringify({ id: null, ok: false, error: "плохой JSON: " + e.message }) + "\n");
        continue;
      }
      handleClientRequest(sock, req);
    }
  });
  sock.on("error", (e) => log("ошибка клиента:", e.message));
});

async function handleClientRequest(sock, req) {
  const reply = (obj) => {
    if (!sock.destroyed) sock.write(JSON.stringify({ id: req.id, ...obj }) + "\n");
  };

  if (req.op === "__status") {
    reply({ ok: true, value: { extensionReady, pending: pending.size, pid: process.pid } });
    return;
  }
  if (!extensionReady) {
    // Даём расширению шанс подключиться, но не висим вечно.
    const waited = await new Promise((r) => {
      const t = setTimeout(() => r(false), 5000);
      waitingForExtension.push(() => {
        clearTimeout(t);
        r(true);
      });
    });
    if (!waited) {
      reply({ ok: false, error: "расширение ffmcp не подключено к хосту" });
      return;
    }
  }
  reply(await callExtension(req.op, req.params || {}, req.timeoutMs || 45000));
}

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  fs.writeFileSync(OWNER_PATH, String(process.pid));
  log("хост запущен, сокет:", SOCKET_PATH, "pid", process.pid);
});

server.on("error", (e) => {
  log("ошибка сокета:", e.message);
  process.exit(1);
});

// Удаляем сокет только если он всё ещё наш. При перезагрузке расширения
// новый хост стартует раньше, чем умирает старый, и без этой проверки
// уходящий процесс сносил бы сокет уже работающего преемника.
function cleanup() {
  try {
    server.close();
  } catch {}
  try {
    if (fs.readFileSync(OWNER_PATH, "utf8").trim() === String(process.pid) && fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
      fs.unlinkSync(OWNER_PATH);
    }
  } catch {}
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(0);
  });
}
process.on("uncaughtException", (e) => {
  log("uncaught:", e.stack);
});
