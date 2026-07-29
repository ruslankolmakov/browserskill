#!/usr/bin/env node
/* ffmcp — единая точка входа CLI.
 *
 *   ffmcp mcp                    запустить MCP-сервер по stdio (для агентов)
 *   ffmcp doctor                 диагностика установки
 *   ffmcp browsers               какие браузеры подключены к мосту
 *   ffmcp status                 состояние связи с браузером
 *   ffmcp tabs                   список вкладок
 *   ffmcp open <url>             открыть вкладку
 *   ffmcp eval <js> [tabId]      выполнить JS в странице
 *   ffmcp call <op> [json]       произвольная операция моста
 *   ffmcp api <path> [argsJson]  прямой вызов WebExtension API
 *
 * Браузер выбирается флагом --browser=chrome (или -b chrome), переменной
 * FFMCP_BROWSER, иначе автоматически — по тому, чей сокет живой.
 */

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const STATE_DIR = process.env.FFMCP_DIR || path.join(os.homedir(), ".ffmcp");
const BROWSERS = ["firefox", "chrome"];
const socketPath = (browser) => path.join(STATE_DIR, `${browser}.sock`);

// Тот же токен установки, что использует MCP-сервер: одобрив клиента «навсегда»
// однажды, пользователь покрывает и CLI, и агента.
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

const HOST_MANIFESTS = {
  firefox: [path.join(os.homedir(), "Library/Application Support/Mozilla/NativeMessagingHosts/ffmcp.json")],
  chrome: [
    path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/ffmcp.json"),
    path.join(os.homedir(), "Library/Application Support/Chromium/NativeMessagingHosts/ffmcp.json"),
    path.join(os.homedir(), "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/ffmcp.json"),
    path.join(os.homedir(), "Library/Application Support/Microsoft Edge/NativeMessagingHosts/ffmcp.json"),
    path.join(os.homedir(), "Library/Application Support/Arc/User Data/NativeMessagingHosts/ffmcp.json"),
  ],
};

const USAGE = `ffmcp — мост между MCP-агентами и браузером (Firefox, Chrome)

  ffmcp mcp                    запустить MCP-сервер по stdio (для агентов)
  ffmcp doctor                 диагностика установки
  ffmcp browsers               какие браузеры подключены к мосту
  ffmcp status                 состояние связи с браузером
  ffmcp windows                список окон (target — закреплённое)
  ffmcp use-window <id|release> закрепить рабочее окно или снять закрепление
  ffmcp new-window [url]       новое окно, сразу закреплённое
  ffmcp tabs [queryJson]       список вкладок
  ffmcp open <url>             открыть вкладку
  ffmcp snapshot [tabId]       интерактивные элементы страницы
  ffmcp read [tabId]           видимый текст страницы
  ffmcp eval <js> [tabId]      выполнить JS в странице
  ffmcp api <path> [argsJson]  прямой вызов WebExtension API
  ffmcp call <op> [paramsJson] произвольная операция моста

Выбор браузера: --browser=chrome | -b chrome | FFMCP_BROWSER=chrome`;

// Вырезает --browser/-b из argv, чтобы команды видели только свои аргументы.
function extractBrowser(argv) {
  let name = process.env.FFMCP_BROWSER || null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--browser=")) name = a.slice("--browser=".length);
    else if (a === "--browser" || a === "-b") name = argv[++i];
    else rest.push(a);
  }
  if (name) {
    name = String(name).toLowerCase();
    if (name !== "auto" && !BROWSERS.includes(name)) {
      console.error(`Неизвестный браузер: ${name}. Допустимы: ${BROWSERS.join(", ")}, auto`);
      process.exit(1);
    }
  }
  return { browser: name === "auto" ? null : name, argv: rest };
}

const live = () => BROWSERS.filter((b) => fs.existsSync(socketPath(b)));

function resolveBrowser(explicit) {
  if (explicit) return explicit;
  const l = live();
  if (l.length === 1) return l[0];
  if (l.length > 1) return l.includes("firefox") ? "firefox" : l[0];
  return "firefox";
}

function callHost(browser, op, params = {}, timeoutMs = 45000) {
  const sockPath = socketPath(browser);
  const CLIENT = { name: "CLI", pid: process.pid, argv: process.argv.slice(2).join(" ").slice(0, 300) };
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(sockPath)) {
      const other = live().filter((b) => b !== browser);
      reject(
        new Error(
          `сокет не найден: ${sockPath}\nЗапусти ${browser} с установленным расширением ffmcp.` +
            (other.length ? `\nСейчас доступен: ${other.join(", ")} (--browser=${other[0]}).` : "")
        )
      );
      return;
    }
    const s = net.createConnection(sockPath);
    let buf = "";
    let timer;
    const arm = (ms, err) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        s.destroy();
        reject(new Error(err));
      }, ms);
    };
    arm(timeoutMs + 5000, "таймаут");
    s.on("connect", () => s.write(JSON.stringify({ id: 1, op, params, timeoutMs, token: TOKEN, client: CLIENT }) + "\n"));
    s.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Хост ждёт, пока пользователь подтвердит доступ в popup расширения.
        if (msg.pending) {
          arm(190000, "таймаут ожидания подтверждения доступа пользователем");
          console.error(`⏳ жду подтверждения доступа в ${browser} (значок ffmcp)…`);
          continue;
        }
        clearTimeout(timer);
        s.end();
        return msg.ok ? resolve(msg.value) : reject(new Error(msg.error));
      }
    });
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function out(v) {
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}

async function browsers() {
  for (const b of BROWSERS) {
    const sockOk = fs.existsSync(socketPath(b));
    if (!sockOk) {
      console.log(`⚪️  ${b.padEnd(8)} — не запущен (сокета нет)`);
      continue;
    }
    try {
      const st = await callHost(b, "__status", {}, 3000);
      if (!st.extensionReady) {
        console.log(`🟡  ${b.padEnd(8)} — хост есть (pid ${st.pid}), расширение не подключено`);
        continue;
      }
      const p = await callHost(b, "ping", {}, 5000);
      console.log(`🟢  ${b.padEnd(8)} — ${p.browser.name} ${p.browser.version}, вкладок: ${p.tabs}`);
    } catch (e) {
      console.log(`🔴  ${b.padEnd(8)} — ${e.message.split("\n")[0]}`);
    }
  }
}

async function doctor(explicit) {
  const checks = [];
  const notes = []; // печатаем после проверок, иначе вывод перемешивается
  const ok = (name, pass, hint) => checks.push({ name, pass, hint });

  ok("Node.js", true, process.version);

  // Хотя бы один браузер должен быть настроен полностью; для остальных
  // сообщаем, но не валим диагностику.
  const targets = explicit ? [explicit] : BROWSERS;
  let anyBrowserOk = false;

  for (const b of targets) {
    const manifests = HOST_MANIFESTS[b].filter((p) => fs.existsSync(p));
    if (!manifests.length) {
      notes.push(`ℹ️   ${b}: манифест native-хоста не найден — запусти ./install.sh`);
      continue;
    }
    ok(`Манифест native-хоста (${b})`, true, manifests.join(", "));

    try {
      const m = JSON.parse(fs.readFileSync(manifests[0], "utf8"));
      const execOk = fs.existsSync(m.path) && !!(fs.statSync(m.path).mode & 0o111);
      ok(`Исполняемый файл хоста (${b})`, execOk, m.path);
      const allowed = m.allowed_extensions || m.allowed_origins;
      ok(`Разрешённые расширения (${b})`, Array.isArray(allowed), (allowed || []).join(", "));
    } catch (e) {
      ok(`Манифест читается (${b})`, false, e.message);
    }

    const sockOk = fs.existsSync(socketPath(b));
    if (!sockOk) {
      notes.push(`ℹ️   ${b}: сокета нет — браузер не запущен либо расширение не загружено`);
      continue;
    }
    ok(`Сокет хоста (${b})`, true, socketPath(b));

    let status = null;
    try {
      status = await callHost(b, "__status", {}, 3000);
      ok(`Расширение подключено (${b})`, !!status.extensionReady, `pid хоста ${status.pid}`);
    } catch (e) {
      ok(`Связь с хостом (${b})`, false, e.message.split("\n")[0]);
    }
    if (status && status.extensionReady) {
      try {
        const p = await callHost(b, "ping", {}, 5000);
        ok(`${b} отвечает`, true, `${p.browser.name} ${p.browser.version}, вкладок: ${p.tabs}`);
        anyBrowserOk = true;
      } catch (e) {
        ok(`${b} отвечает`, false, e.message.split("\n")[0]);
      }
    }
  }

  for (const c of checks) {
    console.log(`${c.pass ? "✅" : "❌"}  ${c.name}${c.hint ? " — " + c.hint : ""}`);
  }
  for (const n of notes) console.log(n);
  if (!anyBrowserOk) console.log("❌  Ни один браузер не отвечает — запусти его и загрузи расширение ffmcp");
  process.exit(checks.every((c) => c.pass) && anyBrowserOk ? 0 : 1);
}

async function main() {
  const { browser: explicit, argv } = extractBrowser(process.argv.slice(2));
  const [cmd, ...rest] = argv;
  const parse = (s, fallback) => (s ? JSON.parse(s) : fallback);
  const target = resolveBrowser(explicit);
  const host = (op, params, timeoutMs) => callHost(target, op, params, timeoutMs);

  switch (cmd) {
    case "mcp":
      require(path.join(__dirname, "ffmcp-mcp.js"));
      return;
    case "host":
      require(path.join(__dirname, "ffmcp-host.js"));
      return;
    case "doctor":
      return doctor(explicit);
    case "browsers":
      return browsers();
    case "status":
      return out(await host("ping"));
    case "windows":
      return out(await host("windows.list"));
    case "use-window":
      return out(
        rest[0] === "release"
          ? await host("session.useWindow", { release: true })
          : await host("session.useWindow", rest[0] ? { windowId: Number(rest[0]) } : {})
      );
    case "new-window":
      return out(await host("session.newWindow", { url: rest[0] }));
    case "tabs":
      return out(await host("tabs.list", { query: parse(rest[0], {}) }));
    case "open":
      return out(await host("tabs.open", { url: rest[0] }));
    case "snapshot":
      return out(await host("page.snapshot", { tabId: rest[0] ? Number(rest[0]) : undefined }));
    case "read":
      return out(await host("page.text", { tabId: rest[0] ? Number(rest[0]) : undefined }));
    case "eval":
      return out(
        await host("page.eval", {
          expression: rest[0],
          tabId: rest[1] ? Number(rest[1]) : undefined,
        })
      );
    case "api":
      return out(await host("browser.call", { path: rest[0], args: parse(rest[1], []) }));
    case "call":
      return out(await host(rest[0], parse(rest[1], {})));
    default:
      if (cmd) console.error(`Неизвестная команда: ${cmd}\n`);
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("Ошибка:", e.message);
  process.exit(1);
});
