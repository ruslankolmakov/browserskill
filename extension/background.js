/* browserskill bridge — background script.
 *
 * Держит соединение с native-messaging хостом `browserskill` и исполняет
 * приходящие от него операции с полными правами WebExtension API.
 */

const HOST_NAME = "browserskill";
const CHUNK_LIMIT = 700 * 1024; // native messaging ограничивает размер сообщения

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
  const ba = browser.browserAction;
  if (pendingApprovals.size) {
    ba.setBadgeText({ text: "!" });
    ba.setBadgeBackgroundColor({ color: "#E8A400" });
  } else if (port !== null) {
    ba.setBadgeText({ text: "on" });
    ba.setBadgeBackgroundColor({ color: "#12A150" });
  } else {
    ba.setBadgeText({ text: "off" });
    ba.setBadgeBackgroundColor({ color: "#C62828" });
  }
}

// Состояние для popup (top-level const не виден через getBackgroundPage).
window.__browserskill = {
  consoleLog,
  networkLog,
  connected: () => port !== null,
  targetWindow: () => targetWindow(),
  reconnect: () => { if (port) port.disconnect(); port = null; connect(); },
  pendingApprovals: () => [...pendingApprovals.values()],
  decideApproval: (reqId, decision, scope) => {
    if (port) port.postMessage({ type: "approval-decision", reqId, decision, scope });
    pendingApprovals.delete(reqId);
    browser.notifications.clear("browserskill-approval-" + reqId).catch(() => {});
    refreshBadge();
  },
};

function onApprovalRequest(msg) {
  pendingApprovals.set(msg.reqId, {
    reqId: msg.reqId,
    client: msg.client || {},
    token: msg.token || null,
    ts: Date.now(),
  });
  const c = msg.client || {};
  const who = c.name ? `${c.name}${c.pid ? " (pid " + c.pid + ")" : ""}` : "локальный процесс";
  browser.notifications
    .create("browserskill-approval-" + msg.reqId, {
      type: "basic",
      title: "browserskill: запрос доступа к Firefox",
      message: `${who} хочет управлять браузером. Откройте значок browserskill, чтобы разрешить или отклонить.`,
    })
    .catch(() => {});
  refreshBadge();
}

function onApprovalExpired(msg) {
  pendingApprovals.delete(msg.reqId);
  browser.notifications.clear("browserskill-approval-" + msg.reqId).catch(() => {});
  refreshBadge();
}

// Клик по нотификации открывает popup — кнопок в самих нотификациях Firefox нет.
browser.notifications.onClicked.addListener((id) => {
  if (id.startsWith("browserskill-approval-") && browser.browserAction.openPopup) {
    browser.browserAction.openPopup().catch(() => {});
  }
});

function push(buf, entry) {
  buf.push(entry);
  if (buf.length > RING) buf.splice(0, buf.length - RING);
}

// Предохранитель: даже если страница сойдёт с ума, фоновая страница живёт
// в родительском процессе, и захлебнувшийся обработчик блокирует весь UI.
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

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.__browserskill === "console") recordConsole(msg, sender);
  else if (msg.__browserskill === "console-batch" && Array.isArray(msg.items)) {
    for (const item of msg.items.slice(0, 200)) recordConsole(item, sender);
  }
});

for (const ev of ["onBeforeRequest", "onCompleted", "onErrorOccurred"]) {
  browser.webRequest[ev].addListener(
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
  const [tab] = await browser.tabs.query(query);
  if (!tab) throw err(wid === null ? "нет активной вкладки" : `в закреплённом окне ${wid} нет активной вкладки`);
  return tab.id;
}

/* ---------- закреплённое рабочее окно ---------- */

const TARGET_KEY = "browserskillTargetWindow";
let targetWindowId = null;

// Возвращает id закреплённого окна либо null. Если окно закрыли — снимает
// закрепление, чтобы агент не упирался в мёртвый id.
async function targetWindow() {
  if (targetWindowId === null) return null;
  try {
    await browser.windows.get(targetWindowId);
    return targetWindowId;
  } catch {
    targetWindowId = null;
    browser.storage.local.remove(TARGET_KEY).catch(() => {});
    return null;
  }
}

async function bindWindow(windowId) {
  await browser.windows.get(windowId); // бросит, если окна нет
  targetWindowId = windowId;
  await browser.storage.local.set({ [TARGET_KEY]: windowId });
}

browser.storage.local.get(TARGET_KEY).then((s) => {
  if (typeof s[TARGET_KEY] === "number") targetWindowId = s[TARGET_KEY];
});

browser.windows.onRemoved.addListener((id) => {
  if (id === targetWindowId) {
    targetWindowId = null;
    browser.storage.local.remove(TARGET_KEY).catch(() => {});
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
    cookieStoreId: t.cookieStoreId,
  };
}

// Выполняет код в странице и возвращает результат первого фрейма.
async function evalIn(tabId, code, { allFrames = false } = {}) {
  const results = await browser.tabs.executeScript(tabId, {
    code,
    allFrames,
    runAt: "document_idle",
  });
  return allFrames ? results : results[0];
}

// Оборачивает пользовательское выражение так, чтобы поддержать await и
// вернуть JSON-сериализуемый результат либо описание ошибки.
function wrapExpression(expression) {
  return `(async () => {
    // Код выполняется в песочнице контент-скрипта, где console отдельный от
    // страничного. Подменяем его, чтобы вывод дошёл до logs.console.
    const console = new Proxy(window.console, {
      get(target, level) {
        const orig = target[level];
        if (typeof orig !== "function" || !["log", "info", "warn", "error", "debug"].includes(level)) {
          return typeof orig === "function" ? orig.bind(target) : orig;
        }
        return (...args) => {
          try {
            browser.runtime.sendMessage({
              __browserskill: "console",
              level,
              text: args.map((a) => {
                try {
                  return typeof a === "object" && a !== null ? JSON.stringify(a) : String(a);
                } catch (e) { return String(a); }
              }).join(" ").slice(0, 8000),
            });
          } catch (e) {}
          orig.apply(target, args);
        };
      },
    });
    try {
      const __v = await (async () => { ${expression} })();
      return { ok: true, value: (typeof __v === "undefined") ? null
        : JSON.parse(JSON.stringify(__v, (k, val) =>
            (val instanceof Node) ? \`[\${val.nodeName}]\` :
            (typeof val === "function") ? "[Function]" : val)) };
    } catch (e) {
      return { ok: false, error: String(e && e.stack || e) };
    }
  })()`;
}

const SNAPSHOT_CODE = `(() => {
  const out = [];
  let i = 0;
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=textbox],[contenteditable=""],[contenteditable="true"],[onclick]';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    const uid = 'e' + (++i);
    el.setAttribute('data-browserskill-uid', uid);
    const label = (el.getAttribute('aria-label') || el.innerText || el.value ||
                   el.placeholder || el.title || el.alt || '').trim().slice(0, 120);
    out.push({
      uid,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      name: el.getAttribute('name') || null,
      id: el.id || null,
      href: el.getAttribute('href') || null,
      value: (el.value !== undefined && el.type !== 'password') ? String(el.value).slice(0, 200) : null,
      checked: el.checked ?? null,
      disabled: !!el.disabled,
      text: label,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    });
    if (i >= 500) break;
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

function byUid(uid) {
  return `document.querySelector('[data-browserskill-uid=${JSON.stringify(uid)}]')`;
}

function resolveTarget({ uid, selector }) {
  if (uid) return byUid(uid);
  if (selector) return `document.querySelector(${JSON.stringify(selector)})`;
  throw err("нужен uid или selector");
}

/* ---------- операции ---------- */

const OPS = {
  /* --- «полный доступ»: прямой вызов любого метода WebExtension API --- */
  async "browser.call"({ path, args = [] }) {
    if (typeof path !== "string" || !path) throw err("path обязателен");
    const parts = path.split(".");
    let ctx = browser;
    for (const p of parts.slice(0, -1)) {
      ctx = ctx?.[p];
      if (!ctx) throw err(`нет такого пространства имён: ${path}`);
    }
    const fn = ctx[parts[parts.length - 1]];
    if (typeof fn !== "function") throw err(`browser.${path} не является функцией`);
    return await fn.apply(ctx, args);
  },

  async "browser.describe"({ path = "" }) {
    let ctx = browser;
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
    return { path: path || "browser", methods: methods.sort(), namespaces: namespaces.sort() };
  },

  /* --- рабочее окно --- */
  async "session.useWindow"({ windowId, release = false }) {
    if (release) {
      targetWindowId = null;
      await browser.storage.local.remove(TARGET_KEY);
      return { bound: false, message: "закрепление снято, работаем в активном окне" };
    }
    if (windowId === undefined || windowId === null) return OPS["session.target"]({});
    await bindWindow(windowId);
    const w = await browser.windows.get(windowId, { populate: true });
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
    const w = await browser.windows.get(wid, { populate: true });
    return { bound: true, windowId: wid, focused: w.focused, tabs: (w.tabs || []).map(slimTab) };
  },

  async "session.newWindow"({ url, private: priv = false, width, height, bind = true }) {
    const props = { incognito: priv };
    if (url) props.url = url;
    if (width) props.width = width;
    if (height) props.height = height;
    const w = await browser.windows.create(props);
    if (bind) await bindWindow(w.id);
    return {
      windowId: w.id,
      bound: bind,
      incognito: w.incognito,
      tabs: (w.tabs || []).map(slimTab),
    };
  },

  /* --- вкладки --- */
  async "tabs.list"({ query = {}, allWindows = false }) {
    const q = { ...query };
    if (!allWindows && q.windowId === undefined) {
      const wid = await targetWindow();
      if (wid !== null) q.windowId = wid;
    }
    return (await browser.tabs.query(q)).map(slimTab);
  },
  async "tabs.get"({ tabId }) {
    return slimTab(await browser.tabs.get(await resolveTabId(tabId)));
  },
  async "tabs.open"({ url, active = true, windowId, pinned = false, cookieStoreId }) {
    const props = { active, pinned };
    if (url) props.url = url;
    if (windowId === undefined) {
      const wid = await targetWindow();
      if (wid !== null) props.windowId = wid;
    } else props.windowId = windowId;
    if (cookieStoreId) props.cookieStoreId = cookieStoreId;
    return slimTab(await browser.tabs.create(props));
  },
  async "tabs.close"({ tabId, tabIds }) {
    const ids = tabIds || [await resolveTabId(tabId)];
    await browser.tabs.remove(ids);
    return { closed: ids };
  },
  async "tabs.activate"({ tabId }) {
    const t = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(t.windowId, { focused: true });
    return slimTab(t);
  },
  async "tabs.navigate"({ tabId, url, waitLoad = true, timeoutMs = 30000 }) {
    const id = await resolveTabId(tabId);
    await browser.tabs.update(id, { url });
    if (waitLoad) await waitForLoad(id, timeoutMs);
    return slimTab(await browser.tabs.get(id));
  },
  async "tabs.reload"({ tabId, bypassCache = false, waitLoad = true, timeoutMs = 30000 }) {
    const id = await resolveTabId(tabId);
    await browser.tabs.reload(id, { bypassCache });
    if (waitLoad) await waitForLoad(id, timeoutMs);
    return slimTab(await browser.tabs.get(id));
  },
  async "tabs.back"({ tabId }) {
    await browser.tabs.goBack(await resolveTabId(tabId));
    return { ok: true };
  },
  async "tabs.forward"({ tabId }) {
    await browser.tabs.goForward(await resolveTabId(tabId));
    return { ok: true };
  },
  async "tabs.waitLoad"({ tabId, timeoutMs = 30000 }) {
    const id = await resolveTabId(tabId);
    await waitForLoad(id, timeoutMs);
    return slimTab(await browser.tabs.get(id));
  },

  /* --- окна --- */
  async "windows.list"() {
    const ws = await browser.windows.getAll({ populate: true });
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
    return await browser.windows.create(props);
  },
  async "windows.close"({ windowId }) {
    await browser.windows.remove(windowId);
    return { ok: true };
  },

  /* --- содержимое страницы --- */
  async "page.snapshot"({ tabId }) {
    return await evalIn(await resolveTabId(tabId), SNAPSHOT_CODE);
  },
  async "page.text"({ tabId, selector, maxChars = 40000 }) {
    const target = selector
      ? `document.querySelector(${JSON.stringify(selector)})`
      : "document.body";
    const code = `(() => { const el = ${target};
      return el ? el.innerText.slice(0, ${maxChars}) : null; })()`;
    return { text: await evalIn(await resolveTabId(tabId), code) };
  },
  async "page.html"({ tabId, selector, maxChars = 200000 }) {
    const target = selector
      ? `document.querySelector(${JSON.stringify(selector)})`
      : "document.documentElement";
    const code = `(() => { const el = ${target};
      return el ? el.outerHTML.slice(0, ${maxChars}) : null; })()`;
    return { html: await evalIn(await resolveTabId(tabId), code) };
  },
  async "page.eval"({ tabId, expression, allFrames = false }) {
    const id = await resolveTabId(tabId);
    const res = await evalIn(id, wrapExpression(expression), { allFrames });
    if (allFrames) return res;
    if (!res) throw err("скрипт не вернул результат (страница защищена CSP?)");
    if (!res.ok) throw err(res.error);
    return res.value;
  },
  async "page.click"({ tabId, uid, selector, timeoutMs = 5000 }) {
    const t = resolveTarget({ uid, selector });
    const code = wrapExpression(`
      const deadline = Date.now() + ${timeoutMs};
      let el = ${t};
      while (!el && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 100));
        el = ${t};
      }
      if (!el) throw new Error('элемент не найден');
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { clicked: el.tagName.toLowerCase() };
    `);
    const res = await evalIn(await resolveTabId(tabId), code);
    if (!res.ok) throw err(res.error);
    return res.value;
  },
  async "page.fill"({ tabId, uid, selector, value, submit = false }) {
    const t = resolveTarget({ uid, selector });
    const code = wrapExpression(`
      const el = ${t};
      if (!el) throw new Error('элемент не найден');
      el.focus();
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, ${JSON.stringify(String(value ?? ""))});
      else el.value = ${JSON.stringify(String(value ?? ""))};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      ${submit ? "if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();" : ""}
      return { filled: true };
    `);
    const res = await evalIn(await resolveTabId(tabId), code);
    if (!res.ok) throw err(res.error);
    return res.value;
  },
  async "page.press"({ tabId, uid, selector, key }) {
    const t = uid || selector ? resolveTarget({ uid, selector }) : "document.activeElement";
    const code = wrapExpression(`
      const el = ${t};
      if (!el) throw new Error('элемент не найден');
      el.focus();
      for (const type of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(type, {
          key: ${JSON.stringify(key)}, bubbles: true, cancelable: true
        }));
      }
      return { key: ${JSON.stringify(key)} };
    `);
    const res = await evalIn(await resolveTabId(tabId), code);
    if (!res.ok) throw err(res.error);
    return res.value;
  },
  async "page.waitFor"({ tabId, selector, expression, timeoutMs = 15000 }) {
    const cond = expression
      ? `(${expression})`
      : `!!document.querySelector(${JSON.stringify(selector)})`;
    const code = wrapExpression(`
      const deadline = Date.now() + ${timeoutMs};
      while (Date.now() < deadline) {
        try { if (${cond}) return { matched: true, waitedMs: ${timeoutMs} - (deadline - Date.now()) }; } catch (e) {}
        await new Promise(r => setTimeout(r, 150));
      }
      throw new Error('таймаут ожидания');
    `);
    const res = await evalIn(await resolveTabId(tabId), code);
    if (!res.ok) throw err(res.error);
    return res.value;
  },
  async "page.screenshot"({ tabId, format = "png", quality = 70, fullPage = false }) {
    const id = await resolveTabId(tabId);
    const tab = await browser.tabs.get(id);
    if (fullPage) {
      // Расширяем область захвата на всю прокручиваемую высоту.
      const dims = await evalIn(id, `({
        w: document.documentElement.scrollWidth,
        h: document.documentElement.scrollHeight })`);
      const dataUrl = await browser.tabs.captureTab(id, {
        format, quality,
        rect: { x: 0, y: 0, width: dims.w, height: Math.min(dims.h, 20000) },
      });
      return { dataUrl, format };
    }
    return { dataUrl: await browser.tabs.captureTab(id, { format, quality }), format, windowId: tab.windowId };
  },
  async "page.injectConsoleCapture"({ tabId }) {
    const id = await resolveTabId(tabId);
    await browser.tabs.executeScript(id, { file: "console-hook.js", allFrames: true, runAt: "document_start" });
    return { installed: true, tabId: id };
  },
  async "page.find"({ tabId, query, caseSensitive = false }) {
    const id = await resolveTabId(tabId);
    return await browser.find.find(query, { tabId: id, caseSensitive, includeRangeData: false });
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
    return await browser.cookies.getAll(q);
  },
  async "cookies.set"(details) {
    return await browser.cookies.set(details);
  },
  async "cookies.remove"({ url, name, storeId }) {
    return await browser.cookies.remove({ url, name, storeId });
  },
  async "history.search"({ text = "", maxResults = 100, startTime, endTime }) {
    const q = { text, maxResults };
    if (startTime) q.startTime = startTime;
    if (endTime) q.endTime = endTime;
    return await browser.history.search(q);
  },
  async "history.delete"({ url, startTime, endTime }) {
    if (url) return await browser.history.deleteUrl({ url });
    return await browser.history.deleteRange({ startTime, endTime });
  },
  async "bookmarks.search"({ query }) {
    return await browser.bookmarks.search(query ?? {});
  },
  async "bookmarks.tree"() {
    return await browser.bookmarks.getTree();
  },
  async "bookmarks.create"(props) {
    return await browser.bookmarks.create(props);
  },
  async "bookmarks.remove"({ id, recursive = false }) {
    return recursive ? browser.bookmarks.removeTree(id) : browser.bookmarks.remove(id);
  },
  async "downloads.list"({ query = {} }) {
    return await browser.downloads.search(query);
  },
  async "downloads.start"(props) {
    return { id: await browser.downloads.download(props) };
  },
  async "storage.get"({ area = "local", tabId, keys = null }) {
    if (tabId !== undefined && tabId !== null) {
      const code = wrapExpression(`
        const dump = (s) => Object.fromEntries(Object.entries(s));
        return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
      `);
      const res = await evalIn(await resolveTabId(tabId), code);
      if (!res.ok) throw err(res.error);
      return res.value;
    }
    return await browser.storage[area].get(keys);
  },
  async "containers.list"() {
    return await browser.contextualIdentities.query({});
  },
  async "sessions.recent"({ maxResults = 25 }) {
    return await browser.sessions.getRecentlyClosed({ maxResults });
  },
  async "sessions.restore"({ sessionId }) {
    return await browser.sessions.restore(sessionId);
  },

  /* --- служебное --- */
  async ping() {
    const info = await browser.runtime.getBrowserInfo();
    const tabs = await browser.tabs.query({});
    return { ok: true, browser: info, tabs: tabs.length, extension: browser.runtime.id };
  },
};

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      fn(arg);
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") finish(resolve, true);
    };
    const timer = setTimeout(() => finish(reject, err("таймаут загрузки страницы")), timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs.get(tabId).then((t) => {
      if (t.status === "complete") finish(resolve, true);
    }).catch(() => {});
  });
}

/* ---------- транспорт ---------- */

function sendResult(id, ok, payload) {
  const message = ok ? { type: "result", id, ok: true, value: payload }
                     : { type: "result", id, ok: false, error: payload };
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
    port = browser.runtime.connectNative(HOST_NAME);
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
    const e = browser.runtime.lastError || (port && port.error);
    console.warn("[browserskill] хост отключился:", e && e.message);
    port = null;
    // Хост ушёл — решать по висящим запросам больше некому.
    for (const id of pendingApprovals.keys()) browser.notifications.clear("browserskill-approval-" + id).catch(() => {});
    pendingApprovals.clear();
    scheduleReconnect();
  });

  connectedAt = Date.now();
  port.postMessage({ type: "hello", extension: browser.runtime.id, version: browser.runtime.getManifest().version });
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

// Ставим перехват console на каждую загружаемую страницу.
browser.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  browser.tabs
    .executeScript(tabId, { file: "console-hook.js", frameId, runAt: "document_start" })
    .catch(() => {});
});

connect();
