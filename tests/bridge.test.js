// E2E: фейковое "расширение" вместо Firefox + настоящий CLI.
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(os.tmpdir(), "browserskill-e2e-" + process.pid);
fs.mkdirSync(DIR, { recursive: true });
// Этот тест проверяет транспорт CLI → сокет → хост → расширение; гейт
// подтверждения выключаем, ему посвящён отдельный approval.test.js.
const env = { ...process.env, BROWSERSKILL_DIR: DIR, BROWSERSKILL_APPROVAL: "0" };
const ROOT = path.join(__dirname, "..");
const CLI = ROOT + "/bin/browserskill.js";

const host = spawn("node", [ROOT + "/bin/browserskill-host.js"], { env, stdio: ["pipe", "pipe", "inherit"] });

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

setTimeout(() => sendNative({ type: "hello", extension: "browserskill@local", version: "1.0.0" }), 300);

// Запуск CLI как отдельного процесса — ровно так его зовёт агент.
const cli = (...args) =>
  new Promise((resolve) =>
    execFile("node", [CLI, ...args], { env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    )
  );
const json = (r) => JSON.parse(r.stdout);

setTimeout(async () => {
  const fail = (msg) => { console.log("❌ " + msg); process.exitCode = 1; };
  const pass = (msg) => console.log("✅ " + msg);

  const usage = await cli();
  usage.code === 0 && /browserskill/.test(usage.stdout) && !/mcp/i.test(usage.stdout)
    ? pass("usage без MCP") : fail("usage: " + usage.stdout.slice(0, 200));

  const st = await cli("status");
  st.code === 0 && json(st).browser.version === "141.0"
    ? pass("status прошёл через хост в расширение") : fail("status: " + JSON.stringify(st));

  const ev = await cli("eval", "return 1", "7");
  const evv = json(ev);
  evv.params.tabId === 7 && evv.echoed === "page.eval" ? pass("аргументы доходят до расширения") : fail("eval: " + JSON.stringify(evv));

  const call = await cli("call", "page.click", '{"uid":"e2"}');
  json(call).echoed === "page.click" ? pass("call <op> <json> передаёт произвольную операцию") : fail("call: " + call.stdout);

  const api = await cli("api", "tabs.query", '[{"pinned":true}]');
  const apiv = json(api);
  apiv.echoed === "browser.call" && apiv.params.path === "tabs.query" && apiv.params.args[0].pinned === true
    ? pass("api <path> <args> уходит в browser.call") : fail("api: " + api.stdout);

  const err = await cli("call", "page.click", '{"uid":"e1"}');
  err.code !== 0 && /элемент не найден/.test(err.stderr)
    ? pass("ошибки расширения — ненулевой код и текст в stderr") : fail("ошибка: " + JSON.stringify(err));

  const unknown = await cli("нет_такой");
  unknown.code !== 0 && /Неизвестная команда/.test(unknown.stderr) ? pass("неизвестная команда обработана") : fail("неизвестная команда");

  const big = await cli("call", "big");
  json(big).blob.length === 2_000_000 ? pass("сборка чанков (2 МБ)") : fail("чанки: " + big.stdout.slice(0, 200));

  host.kill();
  setTimeout(() => {
    fs.existsSync(path.join(DIR, "firefox.sock")) ? fail("сокет не убран после выхода") : pass("сокет очищен при завершении");
    fs.rmSync(DIR, { recursive: true, force: true });
  }, 400);
}, 800);
