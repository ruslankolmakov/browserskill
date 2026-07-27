#!/usr/bin/env node
/* ffmcp — единая точка входа CLI.
 *
 *   ffmcp mcp                    запустить MCP-сервер по stdio (для агентов)
 *   ffmcp doctor                 диагностика установки
 *   ffmcp status                 состояние связи с Firefox
 *   ffmcp tabs                   список вкладок
 *   ffmcp open <url>             открыть вкладку
 *   ffmcp eval <js> [tabId]      выполнить JS в странице
 *   ffmcp call <op> [json]       произвольная операция моста
 *   ffmcp api <path> [argsJson]  прямой вызов WebExtension API
 */

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const STATE_DIR = process.env.FFMCP_DIR || path.join(os.homedir(), ".ffmcp");
const SOCKET_PATH = path.join(STATE_DIR, "ffmcp.sock");
const HOST_MANIFEST = path.join(
  os.homedir(),
  "Library/Application Support/Mozilla/NativeMessagingHosts/ffmcp.json"
);

const USAGE = `ffmcp — мост между MCP-агентами и Firefox

  ffmcp mcp                    запустить MCP-сервер по stdio (для агентов)
  ffmcp doctor                 диагностика установки
  ffmcp status                 состояние связи с Firefox
  ffmcp windows                список окон (target — закреплённое)
  ffmcp use-window <id|release> закрепить рабочее окно или снять закрепление
  ffmcp new-window [url]       новое окно, сразу закреплённое
  ffmcp tabs [queryJson]       список вкладок
  ffmcp open <url>             открыть вкладку
  ffmcp snapshot [tabId]       интерактивные элементы страницы
  ffmcp read [tabId]           видимый текст страницы
  ffmcp eval <js> [tabId]      выполнить JS в странице
  ffmcp api <path> [argsJson]  прямой вызов WebExtension API
  ffmcp call <op> [paramsJson] произвольная операция моста`;

function callHost(op, params = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(SOCKET_PATH)) {
      reject(new Error(`сокет не найден: ${SOCKET_PATH}\nЗапусти Firefox с установленным расширением ffmcp.`));
      return;
    }
    const s = net.createConnection(SOCKET_PATH);
    let buf = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error("таймаут"));
    }, timeoutMs + 5000);
    s.on("connect", () => s.write(JSON.stringify({ id: 1, op, params, timeoutMs }) + "\n"));
    s.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i === -1) return;
      clearTimeout(timer);
      s.end();
      const msg = JSON.parse(buf.slice(0, i));
      msg.ok ? resolve(msg.value) : reject(new Error(msg.error));
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function out(v) {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

async function doctor() {
  const checks = [];
  const ok = (name, pass, hint) => checks.push({ name, pass, hint });

  ok("Node.js", true, process.version);
  const hasManifest = fs.existsSync(HOST_MANIFEST);
  ok("Манифест native-хоста", hasManifest, hasManifest ? HOST_MANIFEST : "запусти ./install.sh");

  if (hasManifest) {
    try {
      const m = JSON.parse(fs.readFileSync(HOST_MANIFEST, "utf8"));
      const execOk = fs.existsSync(m.path) && !!(fs.statSync(m.path).mode & 0o111);
      ok("Исполняемый файл хоста", execOk, m.path);
      ok("Разрешённые расширения", Array.isArray(m.allowed_extensions), (m.allowed_extensions || []).join(", "));
    } catch (e) {
      ok("Манифест читается", false, e.message);
    }
  }

  const sockOk = fs.existsSync(SOCKET_PATH);
  ok("Сокет хоста", sockOk, sockOk ? SOCKET_PATH : "Firefox не запущен либо расширение не загружено");

  let status = null;
  if (sockOk) {
    try {
      status = await callHost("__status", {}, 3000);
      ok("Расширение подключено", !!status.extensionReady, `pid хоста ${status.pid}`);
    } catch (e) {
      ok("Связь с хостом", false, e.message);
    }
  }
  if (status && status.extensionReady) {
    try {
      const p = await callHost("ping", {}, 5000);
      ok("Firefox отвечает", true, `${p.browser.name} ${p.browser.version}, вкладок: ${p.tabs}`);
    } catch (e) {
      ok("Firefox отвечает", false, e.message);
    }
  }

  for (const c of checks) {
    console.log(`${c.pass ? "✅" : "❌"}  ${c.name}${c.hint ? " — " + c.hint : ""}`);
  }
  process.exit(checks.every((c) => c.pass) ? 0 : 1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const parse = (s, fallback) => (s ? JSON.parse(s) : fallback);

  switch (cmd) {
    case "mcp":
      require(path.join(__dirname, "ffmcp-mcp.js"));
      return;
    case "host":
      require(path.join(__dirname, "ffmcp-host.js"));
      return;
    case "doctor":
      return doctor();
    case "status":
      return out(await callHost("ping"));
    case "windows":
      return out(await callHost("windows.list"));
    case "use-window":
      return out(
        rest[0] === "release"
          ? await callHost("session.useWindow", { release: true })
          : await callHost("session.useWindow", rest[0] ? { windowId: Number(rest[0]) } : {})
      );
    case "new-window":
      return out(await callHost("session.newWindow", { url: rest[0] }));
    case "tabs":
      return out(await callHost("tabs.list", { query: parse(rest[0], {}) }));
    case "open":
      return out(await callHost("tabs.open", { url: rest[0] }));
    case "snapshot":
      return out(await callHost("page.snapshot", { tabId: rest[0] ? Number(rest[0]) : undefined }));
    case "read":
      return out(await callHost("page.text", { tabId: rest[0] ? Number(rest[0]) : undefined }));
    case "eval":
      return out(
        await callHost("page.eval", {
          expression: rest[0],
          tabId: rest[1] ? Number(rest[1]) : undefined,
        })
      );
    case "api":
      return out(await callHost("browser.call", { path: rest[0], args: parse(rest[1], []) }));
    case "call":
      return out(await callHost(rest[0], parse(rest[1], {})));
    default:
      if (cmd) console.error(`Неизвестная команда: ${cmd}\n`);
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("Ошибка:", e.message);
  process.exit(1);
});
