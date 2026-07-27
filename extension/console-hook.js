/* Перехват console.* и необработанных ошибок страницы.
 *
 * Контент-скрипт живёт в изолированном мире, поэтому в саму страницу
 * инжектируется маленький скрипт. Обмен идёт через CustomEvent со случайным
 * именем, а НЕ через window.postMessage: postMessage видит и сама страница,
 * и если её код логирует принятые сообщения, возникает бесконечная петля
 * console.log → postMessage → обработчик страницы → console.log, способная
 * повесить браузер. Дополнительно стоят защита от реентрантности и лимит
 * частоты — ни одна страница не должна быть в состоянии засыпать фон.
 */
(() => {
  if (window.__ffmcpConsoleHook) return;
  window.__ffmcpConsoleHook = true;

  const CHANNEL = "ffmcp-" + Math.random().toString(36).slice(2);
  const FLUSH_MS = 250;
  const MAX_BATCH = 200;

  let batch = [];
  let timer = null;

  function flush() {
    timer = null;
    if (!batch.length) return;
    const items = batch;
    batch = [];
    browser.runtime.sendMessage({ __ffmcp: "console-batch", items }).catch(() => {});
  }

  // Пачками, а не по сообщению: одна запись в консоль не должна стоить одного IPC.
  document.addEventListener(CHANNEL, (ev) => {
    if (batch.length >= MAX_BATCH) return;
    try {
      batch.push(JSON.parse(String(ev.detail)));
    } catch {
      return;
    }
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  });

  const src = `(() => {
    if (window.__ffmcpPageHook) return;
    window.__ffmcpPageHook = true;

    const CHANNEL = ${JSON.stringify(CHANNEL)};
    const RATE_LIMIT = 100;      // сообщений в секунду
    let sending = false;
    let windowStart = Date.now();
    let sentInWindow = 0;
    let dropped = 0;

    const fmt = (a) => {
      try {
        if (a instanceof Error) return a.stack || String(a);
        return typeof a === "object" && a !== null ? JSON.stringify(a) : String(a);
      } catch (e) { return String(a); }
    };

    const post = (level, text, stack) => {
      // Реентрантность: если console.* вызван из обработчика нашего же события,
      // молча выходим — иначе получится самоподдерживающийся цикл.
      if (sending) return;

      const now = Date.now();
      if (now - windowStart >= 1000) {
        if (dropped) {
          const n = dropped;
          dropped = 0;
          windowStart = now;
          sentInWindow = 1;
          sending = true;
          try {
            document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify({
              level: "warn",
              text: "[ffmcp] пропущено сообщений из-за лимита частоты: " + n,
              stack: null }) }));
          } catch (e) {} finally { sending = false; }
          return;
        }
        windowStart = now;
        sentInWindow = 0;
      }
      if (++sentInWindow > RATE_LIMIT) { dropped++; return; }

      sending = true;
      try {
        document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify({
          level,
          text: String(text).slice(0, 8000),
          stack: stack || null }) }));
      } catch (e) {} finally {
        sending = false;
      }
    };

    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const orig = console[level].bind(console);
      console[level] = function (...args) {
        post(level, args.map(fmt).join(" "));
        orig(...args);
      };
    }
    window.addEventListener("error", (e) => post("uncaught", e.message, e.error && e.error.stack));
    window.addEventListener("unhandledrejection", (e) => post("unhandledrejection", fmt(e.reason)));
  })();`;

  const el = document.createElement("script");
  el.textContent = src;
  (document.head || document.documentElement).appendChild(el);
  el.remove();
})();
