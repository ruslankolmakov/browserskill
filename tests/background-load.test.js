// Загружаем background.js под заглушкой WebExtension API и следим,
// не уходит ли код в синхронный цикл на старте или при обработке вызовов.
const fs = require("node:fs");
const vm = require("node:vm");

const listeners = {};
const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
let nativeMessages = [];

const browser = {
  runtime: {
    id: "browserskill@local",
    onMessage: ev("message"),
    getManifest: () => ({ version: "1.0.0" }),
    getBrowserInfo: async () => ({ name: "Firefox", version: "153.0" }),
    connectNative: () => ({
      postMessage: (m) => nativeMessages.push(m),
      disconnect: () => {},
      onMessage: ev("nativeMsg"),
      onDisconnect: ev("nativeDisc"),
    }),
    sendMessage: async () => {},
    lastError: null,
  },
  webRequest: { onBeforeRequest: ev("req1"), onCompleted: ev("req2"), onErrorOccurred: ev("req3") },
  webNavigation: { onCommitted: ev("nav") },
  windows: {
    get: async (id) => { if (id === 99) throw new Error("нет окна"); return { id, focused: true, tabs: [] }; },
    getAll: async () => [{ id: 1, focused: true, tabs: [] }],
    update: async () => ({}),
    create: async () => ({ id: 2, tabs: [] }),
    remove: async () => {},
    onRemoved: ev("winRemoved"),
  },
  tabs: {
    query: async () => [{ id: 10, windowId: 1, active: true, title: "t", url: "https://x", status: "complete" }],
    get: async () => ({ id: 10, windowId: 1, status: "complete" }),
    executeScript: async () => [{ ok: true, value: null }],
    create: async () => ({ id: 11, windowId: 1 }),
    remove: async () => {},
    update: async () => ({ id: 10, windowId: 1 }),
    onUpdated: ev("tabUpd"),
  },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  browserAction: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {}, openPopup: async () => {} },
  notifications: { create: async () => {}, clear: async () => {}, onClicked: ev("notifClick") },
  find: { find: async () => ({}) },
};

const sandbox = { browser, console, setTimeout, clearTimeout, Date, JSON, Math, Object, Array, Error, Promise, String, Proxy };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const src = fs.readFileSync(require("node:path").join(__dirname, "../extension/background.js"), "utf8");

const t0 = Date.now();
try {
  vm.runInNewContext(src, sandbox, { timeout: 5000, filename: "background.js" });
  console.log(`✅ загрузка завершилась за ${Date.now() - t0} мс, без синхронного цикла`);
} catch (e) {
  console.log(`❌ загрузка: ${e.message}`);
  process.exit(1);
}

// Прогоняем несколько операций через тот же путь, что и native-хост.
(async () => {
  const handle = listeners.nativeMsg;
  if (!handle) { console.log("❌ обработчик native-сообщений не зарегистрирован"); process.exit(1); }
  for (const [op, params] of [
    ["ping", {}],
    ["tabs.list", {}],
    ["session.target", {}],
    ["session.useWindow", {}],
    ["session.useWindow", { windowId: 1 }],
    ["windows.list", {}],
  ]) {
    nativeMessages = [];
    const started = Date.now();
    handle({ type: "call", id: 1, op, params });
    await new Promise((r) => setTimeout(r, 200));
    const got = nativeMessages.find((m) => m.type === "result" || m.type === "chunk");
    console.log(
      `${got ? "✅" : "❌"} ${op.padEnd(20)} ${got ? (got.ok === false ? "ошибка: " + got.error : "ответ за " + (Date.now() - started) + " мс") : "ОТВЕТА НЕТ"}`
    );
  }
  // Симулируем поток сетевых событий — проверяем кольцевой буфер.
  const t = Date.now();
  for (let i = 0; i < 20000; i++) listeners.req1({ requestId: String(i), tabId: 1, url: "https://x/" + i, method: "GET", type: "xhr" });
  console.log(`✅ 20000 сетевых событий за ${Date.now() - t} мс`);
})();
