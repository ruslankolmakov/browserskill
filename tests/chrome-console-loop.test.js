/* То же испытание, что и для Firefox, но для пары контент-скриптов Chrome:
 * console-hook-main.js (мир страницы) + console-hook.js (изолированный мир).
 * Страница-эхо логирует всё, что до неё доходит, — перехватчик обязан рвать
 * петлю и держать лимит частоты.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CHANNEL = "browserskill-console-v1";

function makePage() {
  const custom = {};
  const sent = [];
  let realLogs = 0;

  const doc = {
    addEventListener: (name, fn) => {
      (custom[name] ||= []).push(fn);
    },
    dispatchEvent: (ev) => {
      for (const fn of custom[ev.type] || []) fn(ev);
      return true;
    },
  };

  const win = {
    addEventListener: () => {},
    console: {
      log: () => { realLogs++; },
      info: () => { realLogs++; },
      warn: () => { realLogs++; },
      error: () => { realLogs++; },
      debug: () => { realLogs++; },
    },
  };
  win.window = win;
  win.self = win;
  win.globalThis = win;
  win.document = doc;
  win.console = win.console;
  win.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  win.chrome = { runtime: { sendMessage: async (m) => { sent.push(m); } } };
  win.setTimeout = (fn) => { setTimeout(fn, 0); return 1; };
  win.clearTimeout = () => {};
  win.Date = Date;
  win.Math = Math;
  win.JSON = JSON;
  win.String = String;
  win.Object = Object;
  win.Error = Error;
  win.Array = Array;
  win.Promise = Promise;

  return { win, sent, stats: () => ({ realLogs, sentBatches: sent.length }) };
}

const root = path.join(__dirname, "..", "extension-chrome");
const mainHook = fs.readFileSync(path.join(root, "console-hook-main.js"), "utf8");
const bridgeHook = fs.readFileSync(path.join(root, "console-hook.js"), "utf8");

const page = makePage();
vm.createContext(page.win);

const t0 = Date.now();
try {
  vm.runInContext(bridgeHook, page.win, { timeout: 4000 });
  vm.runInContext(mainHook, page.win, { timeout: 4000 });
} catch (e) {
  console.log("❌ загрузка перехватчиков зациклилась:", e.message);
  process.exit(1);
}
console.log(`✅ загрузка обоих контент-скриптов: ${Date.now() - t0} мс`);

// Страница-эхо: подписалась на тот же канал и логирует всё, что пришло.
vm.runInContext(
  `document.addEventListener(${JSON.stringify(CHANNEL)}, (ev) => { console.log("эхо:", String(ev.detail)); });`,
  page.win,
  { timeout: 4000 }
);

const t1 = Date.now();
try {
  vm.runInContext('console.log("первое сообщение")', page.win, { timeout: 4000 });
} catch (e) {
  console.log("❌ console.log ушёл в бесконечный цикл:", e.message);
  process.exit(1);
}
const s = page.stats();
console.log(`✅ console.log на «эхо-странице»: ${Date.now() - t1} мс, реальных логов ${s.realLogs}`);
if (s.realLogs > 5) {
  console.log(`❌ признаки размножения сообщений: логов ${s.realLogs}`);
  process.exit(1);
}

// Лимит частоты: 5000 записей подряд не должны все дойти до воркера.
const t2 = Date.now();
vm.runInContext("for (let i = 0; i < 5000; i++) console.log('флуд', i);", page.win, { timeout: 5000 });
setTimeout(() => {
  const s2 = page.stats();
  console.log(`✅ 5000 записей за ${Date.now() - t2} мс, наружу ушло ${s2.sentBatches} пачек`);
  if (s2.sentBatches > 150) {
    console.log("❌ лимит частоты не сработал");
    process.exit(1);
  }
  console.log("\nПетля разорвана, флуд ограничен.");
}, 50);
