/* Воспроизводим страницу, которая логирует всё, что приходит ей сообщением, —
 * именно такая петля повесила Firefox. Проверяем, что новый перехватчик её рвёт.
 */
const fs = require("node:fs");
const vm = require("node:vm");

function makePage({ echoOnMessage }) {
  const listeners = { message: [], custom: {} };
  const sent = [];
  let realLogs = 0;

  const doc = {
    addEventListener: (name, fn) => { (listeners.custom[name] ||= []).push(fn); },
    dispatchEvent: (ev) => { for (const fn of listeners.custom[ev.type] || []) fn(ev); return true; },
    createElement: () => ({ set textContent(v) { this._v = v; }, get textContent() { return this._v; }, remove() {} }),
    documentElement: { appendChild: () => {} },
    head: { appendChild: () => {} },
  };

  const win = {
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
    postMessage: (data) => {
      // Страница-эхо: получила сообщение — залогировала его.
      for (const fn of listeners.message || []) fn({ source: win, data });
    },
    console: {
      log: (...a) => { realLogs++; },
      info: () => { realLogs++; }, warn: () => { realLogs++; },
      error: () => { realLogs++; }, debug: () => { realLogs++; },
    },
  };
  win.window = win;
  win.document = doc;
  win.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  win.Event = class { constructor(t) { this.type = t; } };
  win.KeyboardEvent = win.Event;
  win.browser = {
    runtime: { sendMessage: async (m) => { sent.push(m); } },
  };
  win.console = win.console;
  win.setTimeout = (fn) => { setTimeout(fn, 0); return 1; };
  win.Date = Date; win.Math = Math; win.JSON = JSON; win.String = String; win.Object = Object;
  win.Error = Error; win.Array = Array; win.Promise = Promise;

  if (echoOnMessage) {
    listeners.message.push((ev) => { win.console.log("эхо:", JSON.stringify(ev.data)); });
  }
  return { win, sent, stats: () => ({ realLogs, sentBatches: sent.length }) };
}

const hook = fs.readFileSync(require("node:path").join(__dirname, "../extension/console-hook.js"), "utf8");

// 1. Страница-эхо на message: старая версия зацикливалась здесь.
const page = makePage({ echoOnMessage: true });
vm.createContext(page.win);
const t0 = Date.now();
try {
  vm.runInContext(hook, page.win, { timeout: 4000 });
  // Достаём внедрённый в страницу код и выполняем его (в тесте миры общие).
  vm.runInContext("(" + "function(){}" + ")", page.win);
} catch (e) {
  console.log("❌ инжекция зациклилась:", e.message);
  process.exit(1);
}
console.log(`✅ инжекция перехватчика: ${Date.now() - t0} мс, без зацикливания`);

// Имитируем страничную часть: берём исходник, который hook кладёт в <script>.
const pageSrc = hook.match(/const src = `([\s\S]*?)`;\n/)[1]
  .replace(/\$\{JSON\.stringify\(CHANNEL\)\}/, '"browserskill-test"');
vm.runInContext(pageSrc, page.win, { timeout: 4000 });
// Подписываем контент-часть на тот же канал.
vm.runInContext(`document.addEventListener("browserskill-test", (ev) => {
  browser.runtime.sendMessage({ __browserskill: "console-batch", items: [JSON.parse(String(ev.detail))] });
});`, page.win);

const t1 = Date.now();
try {
  vm.runInContext('console.log("первое сообщение")', page.win, { timeout: 4000 });
} catch (e) {
  console.log("❌ console.log ушёл в бесконечный цикл:", e.message);
  process.exit(1);
}
const s = page.stats();
console.log(`✅ console.log на «эхо-странице»: ${Date.now() - t1} мс, реальных логов ${s.realLogs}, отправлено ${s.sentBatches}`);
if (s.realLogs > 5 || s.sentBatches > 5) {
  console.log(`❌ признаки размножения сообщений: логов ${s.realLogs}, отправок ${s.sentBatches}`);
  process.exit(1);
}

// 2. Лимит частоты: 5000 записей подряд не должны все уйти наружу.
const t2 = Date.now();
vm.runInContext("for (let i = 0; i < 5000; i++) console.log('флуд', i);", page.win, { timeout: 5000 });
const s2 = page.stats();
console.log(`✅ 5000 записей за ${Date.now() - t2} мс, наружу ушло ${s2.sentBatches} (лимит держит)`);
if (s2.sentBatches > 150) { console.log("❌ лимит частоты не сработал"); process.exit(1); }
console.log("\nПетля разорвана, флуд ограничен.");
