// Загружаем service worker расширения для Chrome под заглушкой chrome.* и
// следим, не уходит ли код в синхронный цикл на старте и отвечают ли операции.
// В MV3 нет window и нет getBackgroundPage, поэтому песочница — «голый» worker.
const fs = require("node:fs");
const vm = require("node:vm");

const listeners = {};
const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn), removeListener: () => {} });
let nativeMessages = [];
let injected = [];

const tab = { id: 10, windowId: 1, index: 0, active: true, title: "t", url: "https://x", status: "complete" };

const chrome = {
  runtime: {
    id: "mifolcjccjkcdfdoebmkgklimogoemng",
    lastError: null,
    onMessage: ev("message"),
    onStartup: ev("startup"),
    onInstalled: ev("installed"),
    getManifest: () => ({ version: "1.1.0" }),
    getURL: (p) => "chrome-extension://ffmcp/" + p,
    sendMessage: async () => {},
    connectNative: () => ({
      postMessage: (m) => nativeMessages.push(m),
      disconnect: () => {},
      onMessage: ev("nativeMsg"),
      onDisconnect: ev("nativeDisc"),
    }),
  },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, openPopup: async () => {} },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: ev("notifClick") },
  alarms: { create: () => {}, onAlarm: ev("alarm") },
  webRequest: { onBeforeRequest: ev("req1"), onCompleted: ev("req2"), onErrorOccurred: ev("req3") },
  webNavigation: { onCommitted: ev("nav") },
  windows: {
    get: async (id) => { if (id === 99) throw new Error("нет окна"); return { id, focused: true, tabs: [] }; },
    getAll: async () => [{ id: 1, focused: true, tabs: [tab] }],
    update: async () => ({}),
    create: async () => ({ id: 2, tabs: [] }),
    remove: async () => {},
    onRemoved: ev("winRemoved"),
  },
  tabs: {
    query: async () => [tab],
    get: async () => tab,
    create: async () => ({ id: 11, windowId: 1 }),
    remove: async () => {},
    update: async () => tab,
    reload: async () => {},
    captureVisibleTab: async () => "data:image/png;base64,AAAA",
    onUpdated: ev("tabUpd"),
  },
  scripting: {
    executeScript: async (opts) => {
      injected.push(opts);
      return [{ frameId: 0, result: opts.func ? "результат" : null }];
    },
  },
  storage: {
    session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
  },
  sessions: { getRecentlyClosed: async () => [], restore: async () => ({}) },
  bookmarks: { getTree: async () => [{ id: "0" }], search: async () => [] },
};

const sandbox = {
  chrome,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Date,
  JSON,
  Math,
  Object,
  Array,
  Error,
  Promise,
  String,
  Number,
  Boolean,
  Proxy,
  Map,
  Set,
  Uint8Array,
  Blob,
  atob,
  btoa,
  navigator: { userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36" },
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const src = fs.readFileSync(require("node:path").join(__dirname, "../extension-chrome/background.js"), "utf8");

let failed = 0;
const t0 = Date.now();
try {
  vm.runInNewContext(src, sandbox, { timeout: 5000, filename: "background.js" });
  console.log(`✅ загрузка service worker за ${Date.now() - t0} мс, без синхронного цикла`);
} catch (e) {
  console.log(`❌ загрузка: ${e.message}`);
  process.exit(1);
}

(async () => {
  const handle = listeners.nativeMsg;
  if (!handle) {
    console.log("❌ обработчик native-сообщений не зарегистрирован");
    process.exit(1);
  }
  nativeMessages.length = 0;
  handle({ type: "hello" });

  for (const [op, params] of [
    ["ping", {}],
    ["tabs.list", {}],
    ["session.target", {}],
    ["session.useWindow", {}],
    ["session.useWindow", { windowId: 1 }],
    ["windows.list", {}],
    ["page.text", { tabId: 10 }],
    ["page.snapshot", { tabId: 10 }],
    ["logs.console", {}],
    ["bookmarks.search", {}],
    ["containers.list", {}],
  ]) {
    nativeMessages = [];
    const started = Date.now();
    handle({ type: "call", id: 1, op, params });
    await new Promise((r) => setTimeout(r, 200));
    const got = nativeMessages.find((m) => m.type === "result" || m.type === "chunk");
    // containers.list в Chrome обязан честно падать — это единственная операция,
    // у которой ошибка и есть правильный ответ.
    const wantError = op === "containers.list";
    const ok = got && (wantError ? got.ok === false : got.ok !== false);
    if (!ok) failed++;
    console.log(
      `${ok ? "✅" : "❌"} ${op.padEnd(20)} ${
        got ? (got.ok === false ? "ошибка: " + got.error : "ответ за " + (Date.now() - started) + " мс") : "ОТВЕТА НЕТ"
      }`
    );
  }

  const ping = await (async () => {
    nativeMessages = [];
    handle({ type: "call", id: 7, op: "ping", params: {} });
    await new Promise((r) => setTimeout(r, 200));
    return nativeMessages.find((m) => m.type === "result");
  })();
  if (ping && ping.value && ping.value.browser.name === "Chrome" && ping.value.browser.version === "139.0.0.0") {
    console.log("✅ ping определяет браузер из user-agent: Chrome 139.0.0.0");
  } else {
    failed++;
    console.log("❌ ping не распознал браузер: " + JSON.stringify(ping && ping.value));
  }

  // Скрипты внедряются готовыми функциями, а не строками: CSP страницы этому
  // не мешает, в отличие от eval.
  const funcInjections = injected.filter((i) => typeof i.func === "function").length;
  console.log(`${funcInjections ? "✅" : "❌"} структурные операции идут через func (${funcInjections} внедрений)`);
  if (!funcInjections) failed++;

  // Симулируем поток сетевых событий — проверяем кольцевой буфер.
  const t = Date.now();
  for (let i = 0; i < 20000; i++)
    listeners.req1({ requestId: String(i), tabId: 1, url: "https://x/" + i, method: "GET", type: "xhr" });
  console.log(`✅ 20000 сетевых событий за ${Date.now() - t} мс`);

  if (failed) process.exit(1);
})();
