// Выбор браузера: два хоста (firefox + chrome) на одном каталоге состояния,
// один CLI. Проверяем маршрутизацию по -b/--browser/BROWSERSKILL_BROWSER,
// автовыбор без флага и то, что `browsers` видит обоих.
const { spawn, execFile } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(os.tmpdir(), "browserskill-select-" + process.pid);
fs.mkdirSync(DIR, { recursive: true });
const env = { ...process.env, BROWSERSKILL_DIR: DIR, BROWSERSKILL_APPROVAL: "0" };
delete env.BROWSERSKILL_BROWSER;
const ROOT = path.join(__dirname, "..");
const CLI = ROOT + "/bin/browserskill.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let okN = 0;
let failN = 0;
const pass = (m) => { okN++; console.log("✅ " + m); };
const fail = (m) => { failN++; process.exitCode = 1; console.log("❌ " + m); };

// Фейковое расширение поверх native messaging: отвечает своим именем браузера.
function fakeBrowser(name, version) {
  const host = spawn("node", [ROOT + "/bin/browserskill-host.js", `--browser=${name === "Firefox" ? "firefox" : "chrome"}`], {
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
  setTimeout(() => send({ type: "hello", extension: "browserskill@local", version: "1.1.0" }), 200);
  return host;
}

const cli = (args, extraEnv = {}) =>
  new Promise((resolve) =>
    execFile("node", [CLI, ...args], { env: { ...env, ...extraEnv } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr })
    )
  );
const status = async (args, extraEnv) => {
  const r = await cli([...args, "status"], extraEnv);
  if (r.code !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

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

  const list = await cli(["browsers"]);
  /firefox.*Firefox 141/.test(list.stdout) && /chrome.*Chrome 139/.test(list.stdout)
    ? pass("browsers видит оба браузера подключёнными")
    : fail("browsers: " + list.stdout);

  (await status(["-b", "chrome"])).browser.name === "Chrome"
    ? pass("-b chrome маршрутизирует вызов в Chrome")
    : fail("-b chrome");

  (await status(["--browser=firefox"])).browser.name === "Firefox"
    ? pass("--browser=firefox маршрутизирует вызов в Firefox")
    : fail("--browser=firefox");

  (await status([], { BROWSERSKILL_BROWSER: "chrome" })).browser.name === "Chrome"
    ? pass("BROWSERSKILL_BROWSER задаёт браузер без флага")
    : fail("BROWSERSKILL_BROWSER");

  (await status(["-b", "firefox"], { BROWSERSKILL_BROWSER: "chrome" })).browser.name === "Firefox"
    ? pass("явный флаг сильнее переменной окружения")
    : fail("флаг vs env");

  (await status([])).browser.name === "Firefox"
    ? pass("без указания при двух живых браузерах выбирается Firefox")
    : fail("автовыбор");

  const badName = await cli(["-b", "safari", "status"]);
  badName.code !== 0 && /Неизвестный браузер/.test(badName.stderr)
    ? pass("неизвестное имя браузера отклоняется")
    : fail("safari: " + JSON.stringify(badName));

  // Недоступный браузер: сообщение должно подсказывать, кто доступен.
  gc.kill();
  await sleep(500);
  let msg = "";
  try {
    await status(["-b", "chrome"]);
  } catch (e) {
    msg = e.message;
  }
  /chrome/i.test(msg) && /firefox/i.test(msg)
    ? pass("при мёртвом Chrome ошибка подсказывает про доступный Firefox")
    : fail("ошибка недоступности: " + msg);

  (await status([])).browser.name === "Firefox"
    ? pass("после смерти Chrome автовыбор уходит в единственный живой Firefox")
    : fail("автовыбор после смерти Chrome");

  ff.kill();
  await sleep(200);
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${failN ? "❌" : "✅"} выбор браузера: ${okN} проверок ок${failN ? ", " + failN + " упало" : ""}`);
})();
