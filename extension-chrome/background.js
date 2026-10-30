/* browserskill bridge — service worker (Chrome, MV3).
 *
 * Держит соединение с native-messaging хостом `browserskill` (запущенным с
 * --browser=chrome) и исполняет приходящие от него операции с полными правами
 * WebExtension API. Набор операций совпадает с версией для Firefox —
 * различается только то, что MV3 делает иначе: внедрение скриптов через
 * chrome.scripting, скриншот всей страницы сшивкой, состояние в памяти
 * недолговечного воркера.
 */

const HOST_NAME = "browserskill";
const CHUNK_LIMIT = 700 * 1024; // native messaging ограничивает размер сообщения
const CONSOLE_CHANNEL = "browserskill-console-v1"; // совпадает с console-hook*.js
const KEEPALIVE_ALARM = "browserskill-keepalive";

let port = null;
let reconnectDelay = 500;
let connectedAt = 0;

/* ---------- буферы наблюдений (console / network) ---------- */

const RING = 2000;
const consoleLog = [];
const networkLog = [];

// Запросы клиентов на доступ, ждущие решения пользователя в popup.
const pendingApprovals = new Map(); // reqId -> { reqId, client, token, ts }

function refreshBadge() {
  if (pendingApprovals.size) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#E8A400" });
  } else if (port !== null) {
    chrome.action.setBadgeText({ text: "on" });
    chrome.action.setBadgeBackgroundColor({ color: "#12A150" });
  } else {
    chrome.action.setBadgeText({ text: "off" });
    chrome.action.setBadgeBackgroundColor({ color: "#C62828" });
  }
}

function onApprovalRequest(msg) {
  pendingApprovals.set(msg.reqId, {
    reqId: msg.reqId,
    client: msg.client || {},
    token: msg.token || null,
    ts: Date.now(),
  });
  const c = msg.client || {};
  const who = c.name ? `${c.name}${c.pid ? " (pid " + c.pid + ")" : ""}` : "локальный процесс";
  chrome.notifications
    .create("browserskill-approval-" + msg.reqId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "browserskill: запрос доступа к Chrome",
      message: `${who} хочет управлять браузером. Откройте значок browserskill, чтобы разрешить или отклонить.`,
    })
    .catch(() => {});
  refreshBadge();
}

function clearNotification(reqId) {
  try {
    chrome.notifications.clear("browserskill-approval-" + reqId).catch(() => {});
  } catch (e) {}
}

function onApprovalExpired(msg) {
  pendingApprovals.delete(msg.reqId);
  clearNotification(msg.reqId);
  refreshBadge();
}

function decideApproval(reqId, decision, scope) {
  if (port) port.postMessage({ type: "approval-decision", reqId, decision, scope });
  pendingApprovals.delete(reqId);
  clearNotification(reqId);
  refreshBadge();
}

// Клик по нотификации открывает popup. openPopup доступен не во всех сборках,
// поэтому промах не должен ронять обработчик.
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith("browserskill-approval-")) return;
  try {
    chrome.action.openPopup().catch(() => {});
  } catch (e) {}
});

function push(buf, entry) {
  buf.push(entry);
  if (buf.length > RING) buf.splice(0, buf.length - RING);
}

// Предохранитель: захлебнувшийся обработчик в воркере тормозит весь мост.
const INTAKE_LIMIT = 500; // записей в секунду суммарно по всем вкладкам
let intakeWindow = 0;
let intakeCount = 0;
let intakeDropped = 0;

function admit() {
  const now = Date.now();
  if (now - intakeWindow >= 1000) {
    if (intakeDropped) {
      push(consoleLog, {
        ts: now,
        tabId: null,
        url: null,
        level: "warn",
        text: `[browserskill] отброшено записей консоли из-за лимита: ${intakeDropped}`,
        stack: null,
      });
      intakeDropped = 0;
    }
    intakeWindow = now;
    intakeCount = 0;
  }
  if (++intakeCount > INTAKE_LIMIT) {
    intakeDropped++;
    return false;
  }
  return true;
}

function recordConsole(entry, sender) {
  if (!admit()) return;
  push(consoleLog, {
    ts: Date.now(),
    tabId: sender.tab ? sender.tab.id : null,
    url: sender.url || null,
    level: entry.level,
    text: entry.text,
    stack: entry.stack || null,
  });
}

/* ---------- сообщения от контент-скриптов и popup ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.__browserskill === "console") {
    recordConsole(msg, sender);
    return;
  }
  if (msg.__browserskill === "console-batch" && Array.isArray(msg.items)) {
    for (const item of msg.items.slice(0, 200)) recordConsole(item, sender);
    return;
  }
  if (msg.__browserskill === "popup") {
    handlePopup(msg).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
    return true; // ответ придёт асинхронно
  }
});

// В MV3 нет getBackgroundPage — popup общается с воркером сообщениями.
async function handlePopup(msg) {
  switch (msg.cmd) {
    case "state": {
      // Очередь подтверждений собираем первой и никогда не теряем: если
      // какой-то API вдруг откажет, пользователь всё равно должен увидеть
      // кнопки «Разрешить/Отклонить», иначе вызовы висят без объяснений.
      const state = {
        connected: port !== null,
        approvals: [...pendingApprovals.values()],
        consoleCount: consoleLog.length,
        networkCount: networkLog.length,
        target: null,
        tabs: null,
      };
      try {
        state.target = await targetWindow();
      } catch (e) {
        state.warning = "окно: " + String((e && e.message) || e);
      }
      try {
        state.tabs = (await chrome.tabs.query({})).length;
      } catch (e) {
        state.warning = "вкладки: " + String((e && e.message) || e);
      }
      return state;
    }
    case "reconnect":
      if (port) port.disconnect();
      port = null;
      connect();
      return { ok: true };
    case "decide":
      decideApproval(msg.reqId, msg.decision, msg.scope);
      return { ok: true };
    default:
      return { error: "неизвестная команда popup: " + msg.cmd };
  }
}

/* ---------- сетевой журнал ---------- */

for (const ev of ["onBeforeRequest", "onCompleted", "onErrorOccurred"]) {
  chrome.webRequest[ev].addListener(
    (d) => {
      push(networkLog, {
        ts: Date.now(),
        phase: ev.replace("on", "").toLowerCase(),
        requestId: d.requestId,
        tabId: d.tabId,
        method: d.method,
        type: d.type,
        url: d.url,
        statusCode: d.statusCode ?? null,
        error: d.error ?? null,
        fromCache: d.fromCache ?? null,
      });
    },
    { urls: ["<all_urls>"] }
  );
}

/* ---------- вспомогательное ---------- */

function err(message, extra) {
  const e = new Error(message);
  if (extra) Object.assign(e, extra);
  return e;
}

async function resolveTabId(tabId) {
  if (tabId !== undefined && tabId !== null) return tabId;
  const wid = await targetWindow();
  const query = wid === null ? { active: true, currentWindow: true } : { active: true, windowId: wid };
  const [tab] = await chrome.tabs.query(query);
  if (!tab) throw err(wid === null ? "нет активной вкладки" : `в закреплённом окне ${wid} нет активной вкладки`);
  return tab.id;
}

function browserInfo() {
  const ua = navigator.userAgent || "";
  const m = /(Edg|OPR|Brave|Chrome)\/([\d.]+)/.exec(ua);
  const names = { Edg: "Edge", OPR: "Opera", Chrome: "Chrome", Brave: "Brave" };
  return {
    name: m ? names[m[1]] || m[1] : "Chromium",
    version: m ? m[2] : "unknown",
    vendor: "Chromium",
    userAgent: ua,
  };
}

/* ---------- закреплённое рабочее окно ---------- */

const TARGET_KEY = "browserskillTargetWindow";
// undefined — ещё не читали из storage, null — окно не закреплено.
let targetWindowId;

// Возвращает id закреплённого окна либо null. Если окно закрыли — снимает
// закрепление, чтобы агент не упирался в мёртвый id.
async function targetWindow() {
  if (targetWindowId === undefined) {
    try {
      const s = await chrome.storage.session.get(TARGET_KEY);
      targetWindowId = typeof s[TARGET_KEY] === "number" ? s[TARGET_KEY] : null;
    } catch {
      targetWindowId = null;
    }
  }
  if (targetWindowId === null) return null;
  try {
    await chrome.windows.get(targetWindowId);
    return targetWindowId;
  } catch {
    targetWindowId = null;
    chrome.storage.session.remove(TARGET_KEY).catch(() => {});
    return null;
  }
}

async function bindWindow(windowId) {
  await chrome.windows.get(windowId); // бросит, если окна нет
  targetWindowId = windowId;
  await chrome.storage.session.set({ [TARGET_KEY]: windowId });
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === targetWindowId) {
    targetWindowId = null;
    chrome.storage.session.remove(TARGET_KEY).catch(() => {});
  }
});

function slimTab(t) {
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    active: t.active,
    pinned: t.pinned,
    title: t.title,
    url: t.url,
    status: t.status,
    audible: t.audible,
    muted: t.mutedInfo ? t.mutedInfo.muted : false,
    incognito: t.incognito,
  };
}

/* ---------- внедрение кода в страницу ---------- */

// Готовая функция (не строка) — CSP страницы такому внедрению не мешает,
// поэтому все «структурные» операции сделаны через func, а не через eval.
async function runFunc(tabId, func, args = [], { allFrames = false, world = "ISOLATED" } = {}) {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      func,
      args,
      world,
      injectImmediately: true,
    });
  } catch (e) {
    // Отказ во внедрении и ошибка самого скрипта приходят одинаково, поэтому
    // подсказку про служебные страницы вешаем только на первое.
    const msg = String((e && e.message) || e);
    throw err(/cannot be scripted|cannot access|host permission|extension manifest|chrome:\/\//i.test(msg) ? msg + serviceTabHint() : msg);
  }
  if (allFrames) return frames.map((f) => f.result);
  const main = frames.find((f) => f.frameId === 0) || frames[0];
  if (!main) throw err("скрипт не вернул результат" + serviceTabHint());
  // Часть сборок Chrome не отклоняет промис, а кладёт исключение страницы сюда.
  if (main.error) throw err(String(main.error.message || main.error));
  return main.result;
}

function serviceTabHint() {
  return " (служебные страницы chrome://, Chrome Web Store и PDF расширениям недоступны)";
}

// Доступен ли API пользовательских скриптов: он есть только когда пользователь
// разрешил их для расширения (в Chrome до 138 — ещё и режим разработчика).
function userScriptsReady() {
  try {
    return typeof chrome.userScripts?.execute === "function";
  } catch {
    return false;
  }
}

let userWorldConfigured = false;
async function ensureUserWorld() {
  if (userWorldConfigured) return;
  // В мире пользовательских скриптов CSP страницы не действует — это и есть
  // способ выполнить произвольный код на сайтах со строгим script-src.
  await chrome.userScripts.configureWorld({ csp: "script-src 'self' 'unsafe-eval'", messaging: false });
  userWorldConfigured = true;
}

const CSP_BLOCKED = /EvalError|unsafe-eval|Content Security Policy/i;

// Произвольный код: сперва мир страницы (работает почти везде и без
// дополнительных разрешений), при отказе по CSP — мир пользовательских скриптов.
async function runCode(tabId, code, { allFrames = false } = {}) {
  const viaMain = await runFunc(
    tabId,
    (src) => {
      try {
        return (0, eval)(src);
      } catch (e) {
        return { __browserskillInjectError: String((e && e.stack) || e) };
      }
    },
    [code],
    { allFrames, world: "MAIN" }
  );

  const blocked = (r) => r && typeof r === "object" && r.__browserskillInjectError && CSP_BLOCKED.test(r.__browserskillInjectError);
  const anyBlocked = allFrames ? viaMain.some(blocked) : blocked(viaMain);
  if (!anyBlocked) return unwrapInject(viaMain, allFrames);

  if (!userScriptsReady()) {
    throw err(
      "страница запрещает выполнение кода своей CSP. Обход есть: открой chrome://extensions → browserskill bridge → " +
        "включи «Разрешить пользовательские скрипты» (в Chrome до 138 — сначала режим разработчика)"
    );
  }
  await ensureUserWorld();
  const frames = await chrome.userScripts.execute({
    target: { tabId, allFrames },
    js: [{ code }],
    injectImmediately: true,
  });
  const results = allFrames ? frames.map((f) => f.result) : (frames.find((f) => f.frameId === 0) || frames[0] || {}).result;
  return unwrapInject(results, allFrames);
}

function unwrapInject(res, allFrames) {
  const one = (r) => {
    if (r && typeof r === "object" && r.__browserskillInjectError) throw err(r.__browserskillInjectError);
    return r;
  };
  return allFrames ? res.map(one) : one(res);
}

// Оборачивает пользовательское выражение так, чтобы поддержать await и
// вернуть JSON-сериализуемый результат либо описание ошибки.
//
// console подменяется только там, где его ещё не перехватил
// console-hook-main.js: в мире страницы вывод и так дойдёт до logs.console,
// а в мире пользовательских скриптов — нет, и вторая подмена дала бы дубли.
// Переносы строк обязательны: без них любой // -комментарий в выражении
// закомментировал бы хвост обёртки.
function wrapExpression(expression) {
  return [
    "(async () => {",
    "  const __hooked = typeof window !== 'undefined' && window.__browserskillPageHook;",
    "  const __emit = (level, text) => {",
    "    try {",
    "      document.dispatchEvent(new CustomEvent(" + JSON.stringify(CONSOLE_CHANNEL) + ", {",
    "        detail: JSON.stringify({ level, text: String(text).slice(0, 8000), stack: null })",
    "      }));",
    "    } catch (e) {}",
    "  };",
    "  const console = __hooked ? globalThis.console : new Proxy(globalThis.console, {",
    "    get(target, level) {",
    "      const fn = target[level];",
    "      if (typeof fn !== 'function' || !['log','info','warn','error','debug'].includes(level)) {",
    "        return typeof fn === 'function' ? fn.bind(target) : fn;",
    "      }",
    "      return (...args) => {",
    "        __emit(level, args.map((a) => {",
    "          try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); }",
    "          catch (e) { return String(a); }",
    "        }).join(' '));",
    "        fn.apply(target, args);",
    "      };",
    "    },",
    "  });",
    "  try {",
    "    const __v = await (async () => {",
    expression,
    "    })();",
    "    return { ok: true, value: (typeof __v === 'undefined') ? null",
    "      : JSON.parse(JSON.stringify(__v, (k, val) =>",
    "          (typeof Node !== 'undefined' && val instanceof Node) ? '[' + val.nodeName + ']' :",
    "          (typeof val === 'function') ? '[Function]' : val)) };",
    "  } catch (e) {",
    "    return { ok: false, error: String((e && e.stack) || e) };",
    "  }",
    "})()",
  ].join("\n");
}

async function evalExpression(tabId, expression, { allFrames = false } = {}) {
  const res = await runCode(tabId, wrapExpression(expression), { allFrames });
  if (allFrames) return res;
  if (!res) throw err("скрипт не вернул результат" + serviceTabHint());
  // Обёртка всегда отдаёт {ok, …}; что-то другое значит, что движок вернул
  // недождавшийся промис — лучше сказать это прямо, чем отдать пустоту.
  if (typeof res !== "object" || !("ok" in res)) {
    throw err("скрипт вернул результат в неожиданном виде: " + JSON.stringify(res).slice(0, 200));
  }
  if (!res.ok) throw err(res.error);
  return res.value;
}

/* ---------- функции, исполняемые в странице ---------- */

function pageSnapshot() {
  const out = [];
  let i = 0;
  const sel =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=textbox],[contenteditable=""],[contenteditable="true"],[onclick]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;
    const uid = "e" + ++i;
    el.setAttribute("data-browserskill-uid", uid);
    const label = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.alt || "")
      .trim()
      .slice(0, 120);
    out.push({
      uid,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || null,
      role: el.getAttribute("role") || null,
      name: el.getAttribute("name") || null,
      id: el.id || null,
      href: el.getAttribute("href") || null,
      value: el.value !== undefined && el.type !== "password" ? String(el.value).slice(0, 200) : null,
      checked: el.checked ?? null,
      disabled: !!el.disabled,
      text: label,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
    if (i >= 500) break;
  }
  return { url: location.href, title: document.title, elements: out };
}

function requireTarget({ uid, selector }) {
  if (!uid && !selector) throw err("нужен uid или selector");
  return [uid || null, selector || null];
}

/* ---------- операции ---------- */

const OPS = {
  /* --- «полный доступ»: прямой вызов любого метода WebExtension API --- */
  async "browser.call"({ path, args = [] }) {
    if (typeof path !== "string" || !path) throw err("path обязателен");
    const parts = path.split(".");
    let ctx = chrome;
    for (const p of parts.slice(0, -1)) {
      ctx = ctx?.[p];
      if (!ctx) throw err(`нет такого пространства имён: ${path}`);
    }
    const fn = ctx[parts[parts.length - 1]];
    if (typeof fn !== "function") throw err(`chrome.${path} не является функцией`);
    return await fn.apply(ctx, args);
  },

  async "browser.describe"({ path = "" }) {
    let ctx = chrome;
    for (const p of path.split(".").filter(Boolean)) {
      ctx = ctx?.[p];
      if (!ctx) throw err(`нет такого пути: ${path}`);
    }
    const methods = [];
    const namespaces = [];
    for (const k in ctx) {
      const v = ctx[k];
      if (typeof v === "function") methods.push(k);
      else if (v && typeof v === "object") namespaces.push(k);
    }
    return { path: path || "chrome", methods: methods.sort(), namespaces: namespaces.sort() };
  },

  /* --- рабочее окно --- */
  async "session.useWindow"({ windowId, release = false }) {
    if (release) {
      targetWindowId = null;
      await chrome.storage.session.remove(TARGET_KEY);
      return { bound: false, message: "закрепление снято, работаем в активном окне" };
    }
    if (windowId === undefined || windowId === null) return OPS["session.target"]({});
    await bindWindow(windowId);
    const w = await chrome.windows.get(windowId, { populate: true });
    return {
      bound: true,
      windowId,
      tabs: (w.tabs || []).map(slimTab),
      message: `все операции без явного tabId теперь идут в окно ${windowId}`,
    };
  },

  async "session.target"() {
    const wid = await targetWindow();
    if (wid === null) return { bound: false, message: "окно не закреплено — используется активное окно" };
    const w = await chrome.windows.get(wid, { populate: true });
    return { bound: true, windowId: wid, focused: w.focused, tabs: (w.tabs || []).map(slimTab) };
  },

  async "session.newWindow"({ url, private: priv = false, width, height, bind = true }) {
    const props = { incognito: priv };
    if (url) props.url = url;
    if (width) props.width = width;
    if (height) props.height = height;
    const w = await chrome.windows.create(props);
    if (bind) await bindWindow(w.id);
    return { windowId: w.id, bound: bind, incognito: w.incognito, tabs: (w.tabs || []).map(slimTab) };
  },

  /* --- вкладки --- */
  async "tabs.list"({ query = {}, allWindows = false }) {
    const q = { ...query };
    if (!allWindows && q.windowId === undefined) {
      const wid = await targetWindow();
      if (wid !== null) q.windowId = wid;
    }
    return (await chrome.tabs.query(q)).map(slimTab);
  },
  async "tabs.get"({ tabId }) {
    return slimTab(await chrome.tabs.get(await resolveTabId(tabId)));
  },
  async "tabs.open"({ url, active = true, windowId, pinned = false }) {
    const props = { active, pinned };
    if (url) props.url = url;
    if (windowId === undefined) {
      const wid = await targetWindow();
      if (wid !== null) props.windowId = wid;
    } else props.windowId = windowId;
    return slimTab(await chrome.tabs.create(props));
  },
  async "tabs.close"({ tabId, tabIds }) {
    const ids = tabIds || [await resolveTabId(tabId)];
    await chrome.tabs.remove(ids);
    return { closed: ids };
  },
  async "tabs.activate"({ tabId }) {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return slimTab(t);
  },
  async "tabs.navigate"({ tabId, url, waitLoad = true, timeoutMs = 30000 }) {
    const id = await resolveTabId(tabId);
    await chrome.tabs.update(id, { url });
    if (waitLoad) await waitForLoad(id, timeoutMs);
    return slimTab(await chrome.tabs.get(id));
  },
  async "tabs.reload"({ tabId, bypassCache = false, waitLoad = true, timeoutMs = 30000 }) {
    const id = await resolveTabId(tabId);
    await chrome.tabs.reload(id, { bypassCache });
    if (waitLoad) await waitForLoad(id, timeoutMs);
    return slimTab(await chrome.tabs.get(id));
  },
  async "tabs.back"({ tabId }) {
    await chrome.tabs.goBack(await resolveTabId(tabId));
    return { ok: true };
  },
  async "tabs.forward"({ tabId }) {
    await chrome.tabs.goForward(await resolveTabId(tabId));
    return { ok: true };
  },
  async "tabs.waitLoad"({ tabId, timeoutMs = 30000 }) {
    const id = await resolveTabId(tabId);
    await waitForLoad(id, timeoutMs);
    return slimTab(await chrome.tabs.get(id));
  },

  /* --- окна --- */
  async "windows.list"() {
    const ws = await chrome.windows.getAll({ populate: true });
    const wid = await targetWindow();
    return ws.map((w) => ({
      id: w.id,
      focused: w.focused,
      target: w.id === wid,
      state: w.state,
      incognito: w.incognito,
      tabs: (w.tabs || []).map(slimTab),
    }));
  },
  async "windows.open"(props = {}) {
    return await chrome.windows.create(props);
  },
  async "windows.close"({ windowId }) {
    await chrome.windows.remove(windowId);
    return { ok: true };
  },

  /* --- содержимое страницы --- */
  async "page.snapshot"({ tabId }) {
    return await runFunc(await resolveTabId(tabId), pageSnapshot);
  },
  async "page.text"({ tabId, selector, maxChars = 40000 }) {
    const text = await runFunc(
      await resolveTabId(tabId),
      (sel, limit) => {
        const el = sel ? document.querySelector(sel) : document.body;
        return el ? el.innerText.slice(0, limit) : null;
      },
      [selector || null, maxChars]
    );
    return { text };
  },
  async "page.html"({ tabId, selector, maxChars = 200000 }) {
    const html = await runFunc(
      await resolveTabId(tabId),
      (sel, limit) => {
        const el = sel ? document.querySelector(sel) : document.documentElement;
        return el ? el.outerHTML.slice(0, limit) : null;
      },
      [selector || null, maxChars]
    );
    return { html };
  },
  async "page.eval"({ tabId, expression, allFrames = false }) {
    return await evalExpression(await resolveTabId(tabId), expression, { allFrames });
  },
  async "page.click"({ tabId, uid, selector, timeoutMs = 5000 }) {
    const [u, s] = requireTarget({ uid, selector });
    return await runFunc(
      await resolveTabId(tabId),
      async (uid, selector, deadlineMs) => {
        const locate = () =>
          uid ? document.querySelector('[data-browserskill-uid="' + uid + '"]') : document.querySelector(selector);
        const deadline = Date.now() + deadlineMs;
        let el = locate();
        while (!el && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          el = locate();
        }
        if (!el) throw new Error("элемент не найден");
        el.scrollIntoView({ block: "center" });
        el.click();
        return { clicked: el.tagName.toLowerCase() };
      },
      [u, s, timeoutMs]
    );
  },
  async "page.fill"({ tabId, uid, selector, value, submit = false }) {
    const [u, s] = requireTarget({ uid, selector });
    return await runFunc(
      await resolveTabId(tabId),
      (uid, selector, value, submit) => {
        const el = uid ? document.querySelector('[data-browserskill-uid="' + uid + '"]') : document.querySelector(selector);
        if (!el) throw new Error("элемент не найден");
        el.focus();
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value");
        if (setter && setter.set) setter.set.call(el, String(value ?? ""));
        else el.value = String(value ?? "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (submit && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
        return { filled: true };
      },
      [u, s, String(value ?? ""), !!submit]
    );
  },
  async "page.press"({ tabId, uid, selector, key }) {
    return await runFunc(
      await resolveTabId(tabId),
      (uid, selector, key) => {
        const el = uid
          ? document.querySelector('[data-browserskill-uid="' + uid + '"]')
          : selector
            ? document.querySelector(selector)
            : document.activeElement;
        if (!el) throw new Error("элемент не найден");
        el.focus();
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
        }
        return { key };
      },
      [uid || null, selector || null, key]
    );
  },
  async "page.waitFor"({ tabId, selector, expression, timeoutMs = 15000 }) {
    const id = await resolveTabId(tabId);
    // Произвольное выражение — только через eval; селектор обходится без него.
    if (expression) {
      return await evalExpression(
        id,
        `const deadline = Date.now() + ${Number(timeoutMs)};
         while (Date.now() < deadline) {
           try { if (${expression}) return { matched: true }; } catch (e) {}
           await new Promise(r => setTimeout(r, 150));
         }
         throw new Error('таймаут ожидания');`
      );
    }
    if (!selector) throw err("нужен selector или expression");
    return await runFunc(
      id,
      async (selector, deadlineMs) => {
        const started = Date.now();
        const deadline = started + deadlineMs;
        while (Date.now() < deadline) {
          if (document.querySelector(selector)) return { matched: true, waitedMs: Date.now() - started };
          await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error("таймаут ожидания");
      },
      [selector, timeoutMs]
    );
  },
  async "page.screenshot"({ tabId, format = "png", quality = 70, fullPage = false }) {
    const id = await resolveTabId(tabId);
    return fullPage ? await captureFullPage(id, format, quality) : await captureVisible(id, format, quality);
  },
  async "page.injectConsoleCapture"({ tabId }) {
    const id = await resolveTabId(tabId);
    await injectConsoleHook(id);
    return { installed: true, tabId: id };
  },
  async "page.find"({ tabId, query, caseSensitive = false }) {
    // В Chrome нет chrome.find — ищем по тексту сами.
    return await runFunc(
      await resolveTabId(tabId),
      (needle, cs) => {
        const text = document.body ? document.body.innerText : "";
        const hay = cs ? text : text.toLowerCase();
        const q = cs ? needle : needle.toLowerCase();
        let count = 0;
        let i = hay.indexOf(q);
        while (i !== -1 && count < 1000) {
          count++;
          i = hay.indexOf(q, i + q.length);
        }
        return { count };
      },
      [String(query || ""), !!caseSensitive]
    );
  },

  /* --- логи --- */
  async "logs.console"({ tabId, limit = 200, clear = false }) {
    let items = consoleLog;
    if (tabId !== undefined && tabId !== null) items = items.filter((e) => e.tabId === tabId);
    const out = items.slice(-limit);
    if (clear) consoleLog.length = 0;
    return { count: out.length, entries: out };
  },
  async "logs.network"({ tabId, limit = 200, urlContains, clear = false }) {
    let items = networkLog;
    if (tabId !== undefined && tabId !== null) items = items.filter((e) => e.tabId === tabId);
    if (urlContains) items = items.filter((e) => e.url.includes(urlContains));
    const out = items.slice(-limit);
    if (clear) networkLog.length = 0;
    return { count: out.length, entries: out };
  },

  /* --- профиль пользователя --- */
  async "cookies.list"({ url, domain, name, storeId }) {
    const q = {};
    if (url) q.url = url;
    if (domain) q.domain = domain;
    if (name) q.name = name;
    if (storeId) q.storeId = storeId;
    return await chrome.cookies.getAll(q);
  },
  async "cookies.set"(details) {
    return await chrome.cookies.set(details);
  },
  async "cookies.remove"({ url, name, storeId }) {
    return await chrome.cookies.remove({ url, name, storeId });
  },
  async "history.search"({ text = "", maxResults = 100, startTime, endTime }) {
    const q = { text, maxResults };
    if (startTime) q.startTime = startTime;
    if (endTime) q.endTime = endTime;
    return await chrome.history.search(q);
  },
  async "history.delete"({ url, startTime, endTime }) {
    if (url) return await chrome.history.deleteUrl({ url });
    return await chrome.history.deleteRange({ startTime, endTime });
  },
  async "bookmarks.search"({ query }) {
    // chrome.bookmarks.search не принимает пустой запрос — отдаём дерево.
    if (query === undefined || query === null || (typeof query === "object" && !Object.keys(query).length)) {
      return await chrome.bookmarks.getTree();
    }
    return await chrome.bookmarks.search(query);
  },
  async "bookmarks.tree"() {
    return await chrome.bookmarks.getTree();
  },
  async "bookmarks.create"(props) {
    return await chrome.bookmarks.create(props);
  },
  async "bookmarks.remove"({ id, recursive = false }) {
    return recursive ? chrome.bookmarks.removeTree(id) : chrome.bookmarks.remove(id);
  },
  async "downloads.list"({ query = {} }) {
    return await chrome.downloads.search(query);
  },
  async "downloads.start"(props) {
    return { id: await chrome.downloads.download(props) };
  },
  async "storage.get"({ area = "local", tabId, keys = null }) {
    if (tabId !== undefined && tabId !== null) {
      return await runFunc(await resolveTabId(tabId), () => {
        const dump = (s) => Object.fromEntries(Object.entries(s));
        return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
      });
    }
    return await chrome.storage[area].get(keys);
  },
  async "containers.list"() {
    throw err("контейнеры (Multi-Account Containers) есть только в Firefox; в Chrome их аналога нет");
  },
  async "sessions.recent"({ maxResults = 25 }) {
    return await chrome.sessions.getRecentlyClosed({ maxResults });
  },
  async "sessions.restore"({ sessionId }) {
    return await chrome.sessions.restore(sessionId);
  },

  /* --- служебное --- */
  async ping() {
    const tabs = await chrome.tabs.query({});
    return {
      ok: true,
      browser: browserInfo(),
      tabs: tabs.length,
      extension: chrome.runtime.id,
      userScripts: userScriptsReady(),
      // Гейт подтверждения ping не проходит, поэтому это единственный способ
      // со стороны увидеть, дошёл ли запрос доступа до расширения.
      pendingApprovals: pendingApprovals.size,
    };
  },
};

/* ---------- скриншоты ---------- */

// captureVisibleTab снимает активную вкладку окна, поэтому неактивную
// приходится на миг активировать и вернуть фокус обратно.
async function withVisibleTab(tabId, fn) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) return await fn(tab);
  const [prev] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  try {
    return await fn(tab);
  } finally {
    if (prev && prev.id !== tabId) {
      try {
        await chrome.tabs.update(prev.id, { active: true });
      } catch {}
    }
  }
}

// Chrome жёстко ограничивает частоту захвата (~2 раза в секунду).
let lastCaptureAt = 0;
async function capture(windowId, format, quality) {
  const wait = 550 - (Date.now() - lastCaptureAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCaptureAt = Date.now();
  const opts = format === "jpeg" ? { format: "jpeg", quality } : { format: "png" };
  return await chrome.tabs.captureVisibleTab(windowId, opts);
}

async function captureVisible(tabId, format, quality) {
  const dataUrl = await withVisibleTab(tabId, (tab) => capture(tab.windowId, format, quality));
  const tab = await chrome.tabs.get(tabId);
  return { dataUrl, format, windowId: tab.windowId };
}

const MAX_SLICES = 25;

// Полной страницы одним вызовом Chrome не отдаёт: прокручиваем окно и сшиваем
// куски на OffscreenCanvas.
async function captureFullPage(tabId, format, quality) {
  return await withVisibleTab(tabId, async (tab) => {
    const m = await runFunc(tabId, () => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scrollY: window.scrollY,
    }));

    const height = Math.min(m.h, 20000);
    const slices = Math.min(Math.ceil(height / m.vh), MAX_SLICES);
    if (slices <= 1) {
      const dataUrl = await capture(tab.windowId, format, quality);
      return { dataUrl, format, fullPage: false, note: "страница помещается в один экран" };
    }

    // Если экранов больше лимита, холст делаем ровно по снятой части, а не по
    // всей странице, — иначе снизу окажется пустая чёрная полоса.
    const capturedHeight = Math.min(height, slices * m.vh);
    const canvas = new OffscreenCanvas(Math.round(m.vw * m.dpr), Math.round(capturedHeight * m.dpr));
    const ctx = canvas.getContext("2d");
    let covered = 0;

    for (let i = 0; i < slices; i++) {
      const y = await runFunc(
        tabId,
        (top) => {
          window.scrollTo(0, top);
          return window.scrollY;
        },
        [i * m.vh]
      );
      // Даём отрисоваться ленивым картинкам и sticky-элементам.
      await new Promise((r) => setTimeout(r, 120));
      const bmp = await createImageBitmap(dataUrlToBlob(await capture(tab.windowId, format, quality)));
      ctx.drawImage(bmp, 0, Math.round(y * m.dpr));
      bmp.close();
      covered = y + m.vh;
      if (covered >= capturedHeight) break;
    }

    await runFunc(tabId, (top) => window.scrollTo(0, top), [m.scrollY]);

    const blob = await canvas.convertToBlob(
      format === "jpeg" ? { type: "image/jpeg", quality: quality / 100 } : { type: "image/png" }
    );
    return {
      dataUrl: await blobToDataUrl(blob),
      format,
      fullPage: true,
      truncated: capturedHeight < m.h,
      height: Math.min(covered, capturedHeight),
    };
  });
}

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const type = dataUrl.slice(5, comma).split(";")[0];
  const bin = atob(dataUrl.slice(comma + 1));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

async function blobToDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CH = 0x8000; // порциями, иначе apply переполнит стек
  for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return `data:${blob.type};base64,` + btoa(bin);
}

/* ---------- ожидание загрузки ---------- */

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      fn(arg);
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") finish(resolve, true);
    };
    const timer = setTimeout(() => finish(reject, err("таймаут загрузки страницы")), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") finish(resolve, true);
      })
      .catch(() => {});
  });
}

/* ---------- транспорт ---------- */

function sendResult(id, ok, payload) {
  const message = ok ? { type: "result", id, ok: true, value: payload } : { type: "result", id, ok: false, error: payload };
  const json = JSON.stringify(message);
  if (json.length <= CHUNK_LIMIT) {
    port.postMessage(message);
    return;
  }
  const total = Math.ceil(json.length / CHUNK_LIMIT);
  for (let seq = 0; seq < total; seq++) {
    port.postMessage({
      type: "chunk",
      id,
      seq,
      total,
      data: json.slice(seq * CHUNK_LIMIT, (seq + 1) * CHUNK_LIMIT),
    });
  }
}

async function handleCall(msg) {
  const fn = OPS[msg.op];
  if (!fn) {
    sendResult(msg.id, false, `неизвестная операция: ${msg.op}`);
    return;
  }
  try {
    sendResult(msg.id, true, await fn(msg.params || {}));
  } catch (e) {
    sendResult(msg.id, false, String((e && e.message) || e));
  }
}

function connect() {
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    console.error("[browserskill] connectNative провалился:", e);
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "call") handleCall(msg);
    else if (msg.type === "approval-request") onApprovalRequest(msg);
    else if (msg.type === "approval-expired") onApprovalExpired(msg);
  });

  port.onDisconnect.addListener(() => {
    const e = chrome.runtime.lastError;
    console.warn("[browserskill] хост отключился:", e && e.message);
    port = null;
    // Хост ушёл — решать по висящим запросам больше некому.
    for (const id of pendingApprovals.keys()) clearNotification(id);
    pendingApprovals.clear();
    scheduleReconnect();
  });

  connectedAt = Date.now();
  port.postMessage({ type: "hello", extension: chrome.runtime.id, version: chrome.runtime.getManifest().version });
  refreshBadge();
  console.log("[browserskill] подключён к native-хосту");
}

function scheduleReconnect() {
  refreshBadge();
  // Сбрасываем задержку только если соединение реально пожило: иначе
  // «успешный» connectNative с мгновенным отвалом обнуляет backoff и
  // превращает переподключение в цикл со спавном процесса каждые 500 мс.
  if (connectedAt && Date.now() - connectedAt > 10000) reconnectDelay = 500;
  connectedAt = 0;
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

/* ---------- жизненный цикл service worker ---------- */

// Воркер MV3 засыпает без событий, а вместе с ним умирает порт к хосту и
// буферы логов. Открытый порт к native-хосту держит воркер живым (Chrome 116+),
// а будильник — страховка: если воркер всё же усыпили, он его разбудит
// и поднимет связь. 0.5 минуты — минимальный период, который Chrome не режет.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (port === null) connect();
});

for (const ev of [chrome.runtime.onStartup, chrome.runtime.onInstalled]) {
  ev.addListener(() => {
    if (port === null) connect();
    injectIntoOpenTabs();
  });
}

async function injectConsoleHook(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["console-hook-main.js"],
    world: "MAIN",
    injectImmediately: true,
  });
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["console-hook.js"],
    world: "ISOLATED",
    injectImmediately: true,
  });
}

// Декларативные контент-скрипты не попадают во вкладки, открытые до установки
// расширения, — дотягиваемся до них вручную.
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }
  for (const t of tabs) {
    try {
      await injectConsoleHook(t.id);
    } catch {}
  }
}

// Догонять уже открытые вкладки нужно один раз, при установке или старте
// браузера, — на каждое пробуждение воркера это была бы лишняя пачка внедрений.
connect();
