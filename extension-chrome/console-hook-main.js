/* Страничная половина перехвата console.* — мир MAIN.
 *
 * В Chrome MV3 контент-скрипт можно объявить прямо в мире страницы, поэтому
 * никакого внедрения <script> не нужно. Наружу отдаём приватным CustomEvent,
 * а НЕ через window.postMessage: postMessage видит и сама страница, и если её
 * код логирует принятые сообщения (частый паттерн у виджетов и аналитики),
 * возникает петля console.log → postMessage → обработчик страницы → console.log,
 * способная повесить браузер. Дополнительно стоят защита от реентрантности
 * и лимит частоты — ни одна страница не должна засыпать фон.
 *
 * Имя канала обязано совпадать с console-hook.js и background.js.
 */
(() => {
  if (window.__browserskillPageHook) return;
  window.__browserskillPageHook = true;

  const CHANNEL = "browserskill-console-v1";
  const RATE_LIMIT = 100; // сообщений в секунду
  let sending = false;
  let windowStart = Date.now();
  let sentInWindow = 0;
  let dropped = 0;

  const fmt = (a) => {
    try {
      if (a instanceof Error) return a.stack || String(a);
      return typeof a === "object" && a !== null ? JSON.stringify(a) : String(a);
    } catch (e) {
      return String(a);
    }
  };

  const emit = (payload) => {
    sending = true;
    try {
      document.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(payload) }));
    } catch (e) {
    } finally {
      sending = false;
    }
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
        emit({ level: "warn", text: "[browserskill] пропущено сообщений из-за лимита частоты: " + n, stack: null });
        return;
      }
      windowStart = now;
      sentInWindow = 0;
    }
    if (++sentInWindow > RATE_LIMIT) {
      dropped++;
      return;
    }

    emit({ level, text: String(text).slice(0, 8000), stack: stack || null });
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
})();
