#!/usr/bin/env node
/* ffmcp — MCP-сервер поверх stdio.
 *
 * Запускается MCP-клиентом (Claude Code, Cursor, …) как обычный CLI-процесс.
 * Транспорт наружу — stdio JSON-RPC, транспорт к браузеру — Unix-сокет
 * native-хоста. Ни одного HTTP-запроса и ни одного открытого порта.
 *
 * Один сервер обслуживает и Firefox, и Chrome: у каждого браузера свой сокет,
 * агент выбирает браузер вызовом browser_use либо аргументом browser у любого
 * инструмента.
 */

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const STATE_DIR = process.env.FFMCP_DIR || path.join(os.homedir(), ".ffmcp");
const SERVER_INFO = { name: "ffmcp", version: "1.1.0" };

const BROWSERS = ["firefox", "chrome"];
const socketPath = (browser) => path.join(STATE_DIR, `${browser}.sock`);

// Браузер по умолчанию: --browser из командной строки, иначе FFMCP_BROWSER,
// иначе автоопределение по тому, чей сокет живой.
function initialBrowser() {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf("--browser");
  const inline = argv.find((a) => a.startsWith("--browser="));
  const raw =
    (flagIdx !== -1 ? argv[flagIdx + 1] : undefined) ||
    (inline ? inline.slice("--browser=".length) : undefined) ||
    process.env.FFMCP_BROWSER;
  if (!raw) return null;
  const name = String(raw).toLowerCase();
  if (name === "auto") return null;
  if (!BROWSERS.includes(name)) {
    console.error(`ffmcp: неизвестный браузер «${raw}», допустимы: ${BROWSERS.join(", ")}, auto`);
    process.exit(1);
  }
  return name;
}

let pinned = initialBrowser(); // закреплён явно (флаг/env/browser_use)
let lastUsed = null; // последний удачно выбранный автоматически

function available() {
  return BROWSERS.filter((b) => fs.existsSync(socketPath(b)));
}

// Какой браузер обслуживает вызов: явный аргумент → закрепление → последний
// использованный → единственный доступный → firefox.
function resolveBrowser(explicit) {
  if (explicit) {
    const name = String(explicit).toLowerCase();
    if (!BROWSERS.includes(name)) throw new Error(`неизвестный браузер «${explicit}», допустимы: ${BROWSERS.join(", ")}`);
    return name;
  }
  if (pinned) return pinned;
  const live = available();
  if (live.includes(lastUsed)) return lastUsed;
  if (live.length === 1) return live[0];
  if (live.length > 1) return live.includes("firefox") ? "firefox" : live[0];
  return "firefox";
}

// Стабильный токен установки: по нему хост узнаёт «сессионные» и «навсегда»
// одобренные клиенты после переподключения. Лежит рядом с сокетами, 0600.
function clientToken() {
  const p = path.join(STATE_DIR, "client-token");
  try {
    const t = fs.readFileSync(p, "utf8").trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(16).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, t, { mode: 0o600 });
  } catch {}
  return t;
}
const TOKEN = clientToken();
const CLIENT = { name: "MCP-сервер", pid: process.pid, argv: process.argv.slice(1).join(" ").slice(0, 300) };
// Сколько ждать ручного подтверждения пользователя (с запасом над таймаутом хоста).
const APPROVAL_WAIT_MS = 190000;

/* ---------- клиенты Unix-сокетов (по одному на браузер) ---------- */

const links = new Map(); // browser -> { sock, connecting, rxBuf, nextId, waiting }

function link(browser) {
  let l = links.get(browser);
  if (!l) {
    l = { sock: null, connecting: null, rxBuf: "", nextId: 1, waiting: new Map() };
    links.set(browser, l);
  }
  return l;
}

function connect(browser) {
  const l = link(browser);
  if (l.sock && !l.sock.destroyed) return Promise.resolve(l.sock);
  if (l.connecting) return l.connecting;

  const sockPath = socketPath(browser);
  l.connecting = new Promise((resolve, reject) => {
    if (!fs.existsSync(sockPath)) {
      l.connecting = null;
      const other = available().filter((b) => b !== browser);
      reject(
        new Error(
          `сокет ${sockPath} не найден: ${browser} не запущен, расширение ffmcp не установлено ` +
            `или native-хост не зарегистрирован (см. install.sh).` +
            (other.length ? ` Сейчас доступен: ${other.join(", ")} — переключись через browser_use.` : "")
        )
      );
      return;
    }
    const s = net.createConnection(sockPath);
    s.setNoDelay(true);
    s.once("connect", () => {
      l.sock = s;
      l.connecting = null;
      resolve(s);
    });
    s.once("error", (e) => {
      l.connecting = null;
      l.sock = null;
      reject(new Error(`не удалось подключиться к native-хосту ${browser}: ${e.message}`));
    });
    s.on("data", (d) => {
      l.rxBuf += d.toString("utf8");
      let idx;
      while ((idx = l.rxBuf.indexOf("\n")) !== -1) {
        const line = l.rxBuf.slice(0, idx);
        l.rxBuf = l.rxBuf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const w = l.waiting.get(msg.id);
        if (w) {
          l.waiting.delete(msg.id);
          w(msg);
        }
      }
    });
    s.on("close", () => {
      l.sock = null;
      for (const [id, w] of l.waiting) {
        l.waiting.delete(id);
        w({ ok: false, error: `соединение с native-хостом закрыто (${browser} закрыт?)` });
      }
    });
  });
  return l.connecting;
}

async function call(browser, op, params = {}, timeoutMs = 45000) {
  const s = await connect(browser);
  const l = link(browser);
  const id = l.nextId++;
  const res = await new Promise((resolve) => {
    let timer;
    const arm = (ms, err) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        l.waiting.delete(id);
        resolve({ ok: false, error: err });
      }, ms);
    };
    l.waiting.set(id, (m) => {
      // Хост ждёт ручного подтверждения — продлеваем ожидание, не считая это
      // таймаутом операции.
      if (m && m.pending) {
        arm(APPROVAL_WAIT_MS, "таймаут ожидания подтверждения доступа пользователем");
        return;
      }
      clearTimeout(timer);
      resolve(m);
    });
    arm(timeoutMs + 5000, `таймаут ожидания ответа хоста (${timeoutMs} мс)`);
    s.write(JSON.stringify({ id, op, params, timeoutMs, token: TOKEN, client: CLIENT }) + "\n");
  });
  if (!res.ok) throw new Error(res.error);
  lastUsed = browser;
  return res.value;
}

/* ---------- описание инструментов ---------- */

const S = {
  tabId: { type: "number", description: "ID вкладки; если не указан — активная вкладка" },
  browser: {
    type: "string",
    enum: BROWSERS,
    description: "В каком браузере выполнить; по умолчанию — выбранный через browser_use",
  },
  str: (d) => ({ type: "string", description: d }),
  num: (d) => ({ type: "number", description: d }),
  bool: (d) => ({ type: "boolean", description: d }),
  obj: (d) => ({ type: "object", description: d }),
};

const TOOLS = [
  {
    name: "browser_list",
    description:
      "Какие браузеры доступны прямо сейчас (Firefox, Chrome), кто из них подключён к мосту и какой выбран " +
      "по умолчанию. Начинай с этого, если не знаешь, где работать.",
    local: async () => {
      const rows = [];
      for (const b of BROWSERS) {
        const sockOk = fs.existsSync(socketPath(b));
        const row = { browser: b, socket: sockOk, connected: false, current: b === resolveBrowser(null) };
        if (sockOk) {
          try {
            const st = await call(b, "__status", {}, 3000);
            row.connected = !!st.extensionReady;
            row.hostPid = st.pid;
          } catch (e) {
            row.error = e.message;
          }
        }
        rows.push(row);
      }
      return { browsers: rows, pinned: pinned || null, hint: "переключиться: browser_use {browser:'chrome'}" };
    },
    schema: { type: "object", properties: {} },
  },
  {
    name: "browser_use",
    description:
      "Выбрать браузер по умолчанию для всех последующих вызовов (firefox или chrome). " +
      "Без аргументов показывает текущий выбор, release=true возвращает автоопределение.",
    local: async ({ browser, release }) => {
      if (release) {
        pinned = null;
        return { pinned: null, current: resolveBrowser(null), message: "закрепление снято, браузер выбирается автоматически" };
      }
      if (!browser) return { pinned, current: resolveBrowser(null), available: available() };
      const name = resolveBrowser(browser);
      if (!fs.existsSync(socketPath(name))) {
        throw new Error(`${name} недоступен: сокет ${socketPath(name)} не найден. Доступны: ${available().join(", ") || "нет ни одного"}`);
      }
      // Сначала убеждаемся, что браузер действительно отвечает: закреплять
      // мёртвый — значит увести все последующие вызовы в тупик.
      const st = await call(name, "ping", {}, 8000);
      pinned = name;
      return { pinned: name, browser: st.browser, tabs: st.tabs, message: `дальше работаем в ${name}` };
    },
    schema: {
      type: "object",
      properties: { browser: S.browser, release: S.bool("Вернуться к автоопределению браузера") },
    },
  },
  {
    name: "browser_status",
    description:
      "Проверить связь с браузером: его версия, число вкладок, ID расширения. Начинай с этого при проблемах.",
    op: "ping",
    schema: { type: "object", properties: {} },
  },
  {
    name: "browser_api",
    description:
      "ПОЛНЫЙ ДОСТУП: вызвать любой метод WebExtension API напрямую, например path='tabs.query' args=[{}] " +
      "или path='cookies.getAll' args=[{domain:'example.com'}]. Используй, когда специализированного " +
      "инструмента не хватает. Список доступных методов — browser_api_describe (у Firefox и Chrome он разный).",
    op: "browser.call",
    schema: {
      type: "object",
      properties: {
        path: S.str("Путь метода без префикса browser./chrome., например 'tabs.query' или 'downloads.download'"),
        args: { type: "array", description: "Аргументы метода в виде массива JSON" },
      },
      required: ["path"],
    },
  },
  {
    name: "browser_api_describe",
    description: "Перечислить методы и подпространства WebExtension API по указанному пути (пусто = корень).",
    op: "browser.describe",
    schema: { type: "object", properties: { path: S.str("например 'tabs' или 'cookies'") } },
  },
  {
    name: "browser_use_window",
    description:
      "Закрепить рабочее окно: все операции без явного tabId будут идти в активную вкладку именно этого окна, " +
      "а не туда, где пользователь сейчас работает. ID окон смотри в browser_windows. " +
      "Без аргументов показывает текущее закрепление, с release=true снимает его.",
    op: "session.useWindow",
    schema: {
      type: "object",
      properties: {
        windowId: S.num("ID окна из browser_windows"),
        release: S.bool("Снять закрепление и вернуться к активному окну"),
      },
    },
  },
  {
    name: "browser_new_window",
    description:
      "Открыть отдельное окно для работы агента и сразу закрепить его. Лучший способ не мешать пользователю: " +
      "агент работает в своём окне, пользователь — в своих.",
    op: "session.newWindow",
    schema: {
      type: "object",
      properties: {
        url: S.str("Стартовый адрес"),
        private: S.bool("Приватное окно / инкогнито (требует разрешения расширению работать в приватных окнах)"),
        width: S.num("Ширина окна"),
        height: S.num("Высота окна"),
        bind: S.bool("Закрепить как рабочее (по умолчанию true)"),
      },
    },
  },
  {
    name: "browser_tabs",
    description:
      "Список открытых вкладок с ID, URL и заголовками. Если окно закреплено — только его вкладки; " +
      "allWindows=true показывает все.",
    op: "tabs.list",
    schema: {
      type: "object",
      properties: {
        query: S.obj("фильтр tabs.query, например {active:true}"),
        allWindows: S.bool("Показать вкладки всех окон, игнорируя закрепление"),
      },
    },
  },
  {
    name: "browser_open",
    description: "Открыть новую вкладку с URL.",
    op: "tabs.open",
    schema: {
      type: "object",
      properties: {
        url: S.str("Адрес страницы"),
        active: S.bool("Сделать активной (по умолчанию true)"),
        windowId: S.num("В каком окне открыть"),
        cookieStoreId: S.str("Контейнер, только Firefox (см. browser_containers)"),
      },
    },
  },
  {
    name: "browser_navigate",
    description: "Перейти по URL в существующей вкладке и дождаться загрузки.",
    op: "tabs.navigate",
    schema: {
      type: "object",
      properties: { url: S.str("Адрес"), tabId: S.tabId, waitLoad: S.bool("Ждать полной загрузки (по умолчанию true)") },
      required: ["url"],
    },
  },
  {
    name: "browser_close_tab",
    description: "Закрыть вкладку или несколько вкладок.",
    op: "tabs.close",
    schema: { type: "object", properties: { tabId: S.tabId, tabIds: { type: "array", items: { type: "number" } } } },
  },
  {
    name: "browser_activate_tab",
    description: "Сделать вкладку активной и вывести её окно на передний план.",
    op: "tabs.activate",
    schema: { type: "object", properties: { tabId: S.tabId }, required: ["tabId"] },
  },
  {
    name: "browser_reload",
    description: "Перезагрузить вкладку.",
    op: "tabs.reload",
    schema: { type: "object", properties: { tabId: S.tabId, bypassCache: S.bool("Игнорировать кэш") } },
  },
  {
    name: "browser_back",
    description: "Назад по истории вкладки.",
    op: "tabs.back",
    schema: { type: "object", properties: { tabId: S.tabId } },
  },
  {
    name: "browser_forward",
    description: "Вперёд по истории вкладки.",
    op: "tabs.forward",
    schema: { type: "object", properties: { tabId: S.tabId } },
  },
  {
    name: "browser_windows",
    description: "Список окон браузера с их вкладками. Поле target=true отмечает закреплённое рабочее окно.",
    op: "windows.list",
    schema: { type: "object", properties: {} },
  },
  {
    name: "browser_snapshot",
    description:
      "Снимок интерактивных элементов страницы: ссылки, кнопки, поля ввода с их uid. " +
      "Полученный uid передавай в browser_click / browser_fill. Дешевле скриншота.",
    op: "page.snapshot",
    schema: { type: "object", properties: { tabId: S.tabId } },
  },
  {
    name: "browser_read",
    description: "Прочитать видимый текст страницы или её части.",
    op: "page.text",
    schema: {
      type: "object",
      properties: { tabId: S.tabId, selector: S.str("CSS-селектор области"), maxChars: S.num("Лимит символов") },
    },
  },
  {
    name: "browser_html",
    description: "Получить HTML страницы или элемента.",
    op: "page.html",
    schema: { type: "object", properties: { tabId: S.tabId, selector: S.str("CSS-селектор"), maxChars: S.num("Лимит символов") } },
  },
  {
    name: "browser_eval",
    description:
      "Выполнить JavaScript в контексте страницы и вернуть результат. Тело функции: используй return и await. " +
      "Пример: \"return document.title\". Полный доступ к DOM, fetch и переменным страницы.",
    op: "page.eval",
    schema: {
      type: "object",
      properties: {
        expression: S.str("Тело async-функции; результат возвращается через return"),
        tabId: S.tabId,
        allFrames: S.bool("Выполнить во всех фреймах"),
      },
      required: ["expression"],
    },
  },
  {
    name: "browser_click",
    description: "Кликнуть по элементу — по uid из browser_snapshot либо по CSS-селектору.",
    op: "page.click",
    schema: { type: "object", properties: { uid: S.str("uid из snapshot"), selector: S.str("CSS-селектор"), tabId: S.tabId } },
  },
  {
    name: "browser_fill",
    description: "Ввести текст в поле (uid или CSS-селектор), с корректными событиями input/change для React и Vue.",
    op: "page.fill",
    schema: {
      type: "object",
      properties: {
        value: S.str("Что ввести"),
        uid: S.str("uid из snapshot"),
        selector: S.str("CSS-селектор"),
        tabId: S.tabId,
        submit: S.bool("Отправить форму после ввода"),
      },
      required: ["value"],
    },
  },
  {
    name: "browser_press",
    description: "Отправить нажатие клавиши (например Enter, Escape, ArrowDown) элементу или активному полю.",
    op: "page.press",
    schema: {
      type: "object",
      properties: { key: S.str("Имя клавиши, например 'Enter'"), uid: S.str("uid"), selector: S.str("CSS-селектор"), tabId: S.tabId },
      required: ["key"],
    },
  },
  {
    name: "browser_wait_for",
    description: "Дождаться появления элемента по селектору либо истинности JS-выражения.",
    op: "page.waitFor",
    schema: {
      type: "object",
      properties: {
        selector: S.str("CSS-селектор"),
        expression: S.str("JS-выражение, ожидаемое истинным"),
        tabId: S.tabId,
        timeoutMs: S.num("Таймаут, по умолчанию 15000"),
      },
    },
  },
  {
    name: "browser_screenshot",
    description: "Скриншот вкладки. Возвращает изображение.",
    op: "page.screenshot",
    schema: {
      type: "object",
      properties: {
        tabId: S.tabId,
        format: { type: "string", enum: ["png", "jpeg"], description: "Формат, по умолчанию png" },
        quality: S.num("Качество jpeg 0-100"),
        fullPage: S.bool("Снять страницу целиком, а не видимую часть"),
      },
    },
    image: true,
  },
  {
    name: "browser_console",
    description: "Сообщения console.* и необработанные ошибки со страниц.",
    op: "logs.console",
    schema: {
      type: "object",
      properties: { tabId: S.tabId, limit: S.num("Сколько последних записей"), clear: S.bool("Очистить буфер после чтения") },
    },
  },
  {
    name: "browser_network",
    description: "Журнал сетевых запросов браузера (URL, метод, статус, ошибки).",
    op: "logs.network",
    schema: {
      type: "object",
      properties: {
        tabId: S.tabId,
        limit: S.num("Сколько последних записей"),
        urlContains: S.str("Фильтр по подстроке URL"),
        clear: S.bool("Очистить буфер"),
      },
    },
  },
  {
    name: "browser_cookies",
    description: "Прочитать cookies по URL или домену.",
    op: "cookies.list",
    schema: { type: "object", properties: { url: S.str("URL"), domain: S.str("Домен"), name: S.str("Имя cookie"), storeId: S.str("Контейнер") } },
  },
  {
    name: "browser_cookie_set",
    description: "Установить cookie (параметры cookies.set).",
    op: "cookies.set",
    schema: {
      type: "object",
      properties: { url: S.str("URL"), name: S.str("Имя"), value: S.str("Значение"), domain: S.str("Домен"), path: S.str("Путь"), secure: S.bool("Secure"), httpOnly: S.bool("HttpOnly"), expirationDate: S.num("Unix-время истечения") },
      required: ["url", "name", "value"],
    },
  },
  {
    name: "browser_cookie_remove",
    description: "Удалить cookie.",
    op: "cookies.remove",
    schema: { type: "object", properties: { url: S.str("URL"), name: S.str("Имя"), storeId: S.str("Контейнер") }, required: ["url", "name"] },
  },
  {
    name: "browser_history",
    description: "Поиск по истории посещений.",
    op: "history.search",
    schema: { type: "object", properties: { text: S.str("Подстрока поиска, пусто = всё"), maxResults: S.num("Лимит"), startTime: S.num("С какого времени, ms"), endTime: S.num("По какое время, ms") } },
  },
  {
    name: "browser_bookmarks",
    description: "Поиск закладок; без аргументов — вернуть всё дерево.",
    op: "bookmarks.search",
    schema: { type: "object", properties: { query: S.obj("Строка или объект запроса bookmarks.search") } },
  },
  {
    name: "browser_bookmark_create",
    description: "Создать закладку или папку.",
    op: "bookmarks.create",
    schema: { type: "object", properties: { title: S.str("Название"), url: S.str("Адрес; без него создаётся папка"), parentId: S.str("ID родительской папки") } },
  },
  {
    name: "browser_downloads",
    description: "Список загрузок.",
    op: "downloads.list",
    schema: { type: "object", properties: { query: S.obj("Фильтр downloads.search") } },
  },
  {
    name: "browser_download",
    description: "Скачать файл по URL.",
    op: "downloads.start",
    schema: { type: "object", properties: { url: S.str("Адрес файла"), filename: S.str("Имя файла"), saveAs: S.bool("Показать диалог сохранения") }, required: ["url"] },
  },
  {
    name: "browser_storage",
    description: "Прочитать localStorage и sessionStorage вкладки (с tabId) либо storage самого расширения.",
    op: "storage.get",
    schema: { type: "object", properties: { tabId: S.tabId, area: { type: "string", enum: ["local", "sync", "session"] } } },
  },
  {
    name: "browser_containers",
    description: "Список контейнеров (Multi-Account Containers) с их cookieStoreId. Только Firefox.",
    op: "containers.list",
    schema: { type: "object", properties: {} },
  },
  {
    name: "browser_recent_closed",
    description: "Недавно закрытые вкладки и окна.",
    op: "sessions.recent",
    schema: { type: "object", properties: { maxResults: S.num("Лимит") } },
  },
  {
    name: "browser_restore",
    description: "Восстановить закрытую вкладку или окно по sessionId.",
    op: "sessions.restore",
    schema: { type: "object", properties: { sessionId: S.str("sessionId из browser_recent_closed") }, required: ["sessionId"] },
  },
];

// Аргумент browser есть у каждого инструмента, кроме локальных.
for (const t of TOOLS) {
  if (t.op) t.schema.properties.browser = S.browser;
}

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Имена из версии «только Firefox» продолжают работать, но в списке не значатся:
// старые конфиги и промпты не ломаются, новые видят один нейтральный набор.
function legacyTool(name) {
  const m = /^(firefox|chrome)_(.+)$/.exec(name);
  if (!m) return null;
  const alias = m[2] === "status" ? "browser_status" : `browser_${m[2]}`;
  const tool = TOOL_BY_NAME.get(alias);
  return tool ? { tool, browser: m[1] } : null;
}

/* ---------- JSON-RPC поверх stdio ---------- */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  if (id !== undefined && id !== null) write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: text ?? "null" }] };
}

async function callTool(name, args) {
  let tool = TOOL_BY_NAME.get(name);
  const params = { ...(args || {}) };
  if (!tool) {
    const legacy = legacyTool(name);
    if (!legacy) throw new Error(`неизвестный инструмент: ${name}`);
    tool = legacy.tool;
    if (!params.browser) params.browser = legacy.browser;
  }

  if (tool.local) return textResult(await tool.local(params));

  const browser = resolveBrowser(params.browser);
  delete params.browser;
  const value = await call(browser, tool.op, params);

  if (tool.image && value && value.dataUrl) {
    const comma = value.dataUrl.indexOf(",");
    return {
      content: [
        {
          type: "image",
          data: value.dataUrl.slice(comma + 1),
          mimeType: value.format === "jpeg" ? "image/jpeg" : "image/png",
        },
      ],
    };
  }
  return textResult(value);
}

const HANDLERS = {
  initialize: () => ({
    protocolVersion: "2024-11-05",
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions:
      "Управление реальными браузерами пользователя — Firefox и Chrome: вкладки, DOM, JS, cookies, история, " +
      "закладки, загрузки, логи консоли и сети. Работает с уже открытыми профилями, поэтому все авторизации " +
      "сохранены. Браузер выбирается один раз через browser_use (browser_list показывает доступные) либо " +
      "аргументом browser у любого вызова. " +
      "Чтобы не мешать пользователю, закрепи рабочее окно: browser_new_window создаёт отдельное окно " +
      "и делает его целевым, browser_use_window закрепляет существующее. После этого операции без tabId " +
      "идут в закреплённое окно. " +
      "Для навигации по странице сначала вызывай browser_snapshot и действуй по uid. " +
      "Если нужного инструмента нет — используй browser_api для прямого вызова WebExtension API.",
  }),
  ping: () => ({}),
  "tools/list": () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })),
  }),
  "tools/call": async (params) => {
    try {
      return await callTool(params.name, params.arguments);
    } catch (e) {
      return { content: [{ type: "text", text: `Ошибка: ${e.message}` }], isError: true };
    }
  },
  "resources/list": () => ({ resources: [] }),
  "prompts/list": () => ({ prompts: [] }),
};

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf("\n")) !== -1) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    handleRpc(req);
  }
});

async function handleRpc(req) {
  const handler = HANDLERS[req.method];
  if (!handler) {
    if (req.method && req.method.startsWith("notifications/")) return;
    replyError(req.id, -32601, `метод не поддерживается: ${req.method}`);
    return;
  }
  try {
    reply(req.id, await handler(req.params || {}));
  } catch (e) {
    replyError(req.id, -32603, e.message);
  }
}

process.stdin.on("end", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
