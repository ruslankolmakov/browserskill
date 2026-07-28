// E2E: фейковое "расширение" вместо Firefox + настоящий MCP-сервер.
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(os.tmpdir(), "ffmcp-e2e-" + process.pid);
fs.mkdirSync(DIR, { recursive: true });
// Этот тест проверяет транспорт MCP → сокет → хост → расширение; гейт
// подтверждения выключаем, ему посвящён отдельный approval.test.js.
const env = { ...process.env, FFMCP_DIR: DIR, FFMCP_APPROVAL: "0" };
const ROOT = require("node:path").join(__dirname, "..");

const host = spawn("node", [ROOT + "/bin/ffmcp-host.js"], { env, stdio: ["pipe", "pipe", "inherit"] });

function sendNative(msg) {
  const b = Buffer.from(JSON.stringify(msg));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length, 0);
  host.stdin.write(Buffer.concat([h, b]));
}

let hbuf = Buffer.alloc(0);
host.stdout.on("data", (d) => {
  hbuf = Buffer.concat([hbuf, d]);
  for (;;) {
    if (hbuf.length < 4) return;
    const len = hbuf.readUInt32LE(0);
    if (hbuf.length < 4 + len) return;
    const msg = JSON.parse(hbuf.subarray(4, 4 + len).toString());
    hbuf = hbuf.subarray(4 + len);
    if (msg.type === "call") {
      if (msg.op === "ping") {
        sendNative({ type: "result", id: msg.id, ok: true, value: { ok: true, browser: { name: "Firefox", version: "141.0" }, tabs: 3 } });
      } else if (msg.op === "big") {
        // проверяем чанкование крупного ответа
        const json = JSON.stringify({ type: "result", id: msg.id, ok: true, value: { blob: "x".repeat(2_000_000) } });
        const LIMIT = 700 * 1024;
        const total = Math.ceil(json.length / LIMIT);
        for (let seq = 0; seq < total; seq++)
          sendNative({ type: "chunk", id: msg.id, seq, total, data: json.slice(seq * LIMIT, (seq + 1) * LIMIT) });
      } else if (msg.op === "boom" || msg.params?.uid === "e1") {
        sendNative({ type: "result", id: msg.id, ok: false, error: "элемент не найден" });
      } else {
        sendNative({ type: "result", id: msg.id, ok: true, value: { echoed: msg.op, params: msg.params } });
      }
    }
  }
});

setTimeout(() => sendNative({ type: "hello", extension: "ffmcp@local", version: "1.0.0" }), 300);

// --- MCP-клиент ---
setTimeout(async () => {
  const mcp = spawn("node", [ROOT + "/bin/ffmcp-mcp.js"], { env, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const pending = new Map();
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      const r = pending.get(m.id); if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res) => {
    const myId = ++id; pending.set(myId, res);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });

  const fail = (msg) => { console.log("❌ " + msg); process.exitCode = 1; };
  const pass = (msg) => console.log("✅ " + msg);

  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });
  init.result?.serverInfo?.name === "ffmcp" ? pass("initialize") : fail("initialize: " + JSON.stringify(init));

  const list = await rpc("tools/list", {});
  const tools = list.result.tools;
  tools.length > 30 ? pass(`tools/list: ${tools.length} инструментов`) : fail("мало инструментов");
  const bad = tools.filter((t) => !t.name || !t.description || t.inputSchema?.type !== "object");
  bad.length === 0 ? pass("схемы инструментов валидны") : fail("битые схемы: " + bad.map((t) => t.name).join(","));

  const st = await rpc("tools/call", { name: "firefox_status", arguments: {} });
  JSON.parse(st.result.content[0].text).browser.version === "141.0"
    ? pass("tools/call firefox_status прошёл через хост в расширение") : fail("status: " + JSON.stringify(st));

  const ev = await rpc("tools/call", { name: "firefox_eval", arguments: { expression: "return 1", tabId: 7 } });
  const evv = JSON.parse(ev.result.content[0].text);
  evv.params.tabId === 7 && evv.echoed === "page.eval" ? pass("аргументы доходят до расширения") : fail("eval: " + JSON.stringify(evv));

  const err = await rpc("tools/call", { name: "firefox_click", arguments: { uid: "e1" } });
  err.result.isError && /элемент не найден/.test(err.result.content[0].text)
    ? pass("ошибки расширения возвращаются как isError") : fail("ошибка: " + JSON.stringify(err.result));

  const unknown = await rpc("tools/call", { name: "нет_такого", arguments: {} });
  unknown.result.isError ? pass("неизвестный инструмент обработан") : fail("неизвестный инструмент");

  // Чанкование напрямую через сокет
  const net = require("node:net");
  const s = net.createConnection(path.join(DIR, "ffmcp.sock"));
  let sb = "";
  s.on("connect", () => s.write(JSON.stringify({ id: 99, op: "big", params: {} }) + "\n"));
  s.on("data", (d) => {
    sb += d;
    if (sb.includes("\n")) {
      const m = JSON.parse(sb.slice(0, sb.indexOf("\n")));
      m.ok && m.value.blob.length === 2_000_000 ? pass("сборка чанков (2 МБ)") : fail("чанки: " + JSON.stringify(m).slice(0, 200));
      s.end();
      const parallel = rpc("ping", {});
      parallel.then((p) => {
        p.result ? pass("ping") : fail("ping");
        mcp.kill(); host.kill();
        setTimeout(() => {
          fs.existsSync(path.join(DIR, "ffmcp.sock")) ? fail("сокет не убран после выхода") : pass("сокет очищен при завершении");
          fs.rmSync(DIR, { recursive: true, force: true });
        }, 400);
      });
    }
  });
}, 800);
