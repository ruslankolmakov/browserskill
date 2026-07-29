// Выбор браузера: два хоста (firefox + chrome) на одном каталоге состояния,
// один MCP-сервер. Проверяем маршрутизацию по аргументу browser, закрепление
// через browser_use и то, что browser_list видит обоих.
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(os.tmpdir(), "ffmcp-select-" + process.pid);
fs.mkdirSync(DIR, { recursive: true });
const env = { ...process.env, FFMCP_DIR: DIR, FFMCP_APPROVAL: "0" };
const ROOT = path.join(__dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okN = 0;
let failN = 0;
const pass = (m) => { okN++; console.log("✅ " + m); };
const fail = (m) => { failN++; process.exitCode = 1; console.log("❌ " + m); };

// Фейковое расширение поверх native messaging: отвечает своим именем браузера.
function fakeBrowser(name, version) {
  const host = spawn("node", [ROOT + "/bin/ffmcp-host.js", `--browser=${name === "Firefox" ? "firefox" : "chrome"}`], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const send = (msg) => {
    const b = Buffer.from(JSON.stringify(msg));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length, 0);
    host.stdin.write(Buffer.concat([h, b]));
  };
  let buf = Buffer.alloc(0);
  host.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
      buf = buf.subarray(4 + len);
      if (msg.type !== "call") continue;
      if (msg.op === "ping") {
        send({ type: "result", id: msg.id, ok: true, value: { ok: true, browser: { name, version }, tabs: 1 } });
      } else {
        send({ type: "result", id: msg.id, ok: true, value: { echoed: msg.op, from: name, params: msg.params } });
      }
    }
  });
  setTimeout(() => send({ type: "hello", extension: "ffmcp@local", version: "1.1.0" }), 200);
  return host;
}

const ff = fakeBrowser("Firefox", "141.0");
const gc = fakeBrowser("Chrome", "139.0.0.0");

(async () => {
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(path.join(DIR, "firefox.sock")) && fs.existsSync(path.join(DIR, "chrome.sock"))) break;
    await sleep(50);
  }
  fs.existsSync(path.join(DIR, "chrome.sock"))
    ? pass("хост Chrome поднял свой сокет chrome.sock")
    : fail("сокета chrome.sock нет");
  await sleep(500); // даём фейковым расширениям поздороваться с хостами

  const mcp = spawn("node", [ROOT + "/bin/ffmcp-mcp.js"], { env, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const pending = new Map();
  mcp.stdout.on("data", (d) => {
    out += d;
    let i;
    while ((i = out.indexOf("\n")) !== -1) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const tool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args || {} });
    if (r.result?.isError) throw new Error(r.result.content[0].text);
    return JSON.parse(r.result.content[0].text);
  };

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {} });

  const list = await tool("browser_list");
  const byName = Object.fromEntries(list.browsers.map((b) => [b.browser, b]));
  byName.firefox?.connected && byName.chrome?.connected
    ? pass("browser_list видит оба браузера подключёнными")
    : fail("browser_list: " + JSON.stringify(list));

  const inChrome = await tool("browser_status", { browser: "chrome" });
  inChrome.browser.name === "Chrome"
    ? pass("аргумент browser маршрутизирует вызов в Chrome")
    : fail("browser:chrome → " + JSON.stringify(inChrome));

  const inFirefox = await tool("browser_status", { browser: "firefox" });
  inFirefox.browser.name === "Firefox"
    ? pass("аргумент browser маршрутизирует вызов в Firefox")
    : fail("browser:firefox → " + JSON.stringify(inFirefox));

  const used = await tool("browser_use", { browser: "chrome" });
  const afterUse = await tool("browser_status");
  used.pinned === "chrome" && afterUse.browser.name === "Chrome"
    ? pass("browser_use закрепляет браузер для вызовов без аргумента")
    : fail("browser_use: " + JSON.stringify({ used, afterUse }));

  const echoed = await tool("browser_tabs", {});
  echoed.from === "Chrome" ? pass("закрепление действует и на остальные инструменты") : fail("tabs: " + JSON.stringify(echoed));

  const stillFirefox = await tool("browser_status", { browser: "firefox" });
  stillFirefox.browser.name === "Firefox"
    ? pass("явный аргумент сильнее закрепления")
    : fail("явный аргумент: " + JSON.stringify(stillFirefox));

  await tool("browser_use", { release: true });
  const released = await tool("browser_use");
  released.pinned === null ? pass("release снимает закрепление") : fail("release: " + JSON.stringify(released));

  // Недоступный браузер: сообщение должно подсказывать, кто доступен.
  gc.kill();
  await sleep(500);
  let msg = "";
  try {
    await tool("browser_status", { browser: "chrome" });
  } catch (e) {
    msg = e.message;
  }
  /chrome/i.test(msg) && /firefox/i.test(msg)
    ? pass("при мёртвом Chrome ошибка подсказывает про доступный Firefox")
    : fail("ошибка недоступности: " + msg);

  mcp.kill();
  ff.kill();
  await sleep(200);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${failN ? "❌" : "✅"} выбор браузера: ${okN} проверок ок${failN ? ", " + failN + " упало" : ""}`);
})();
