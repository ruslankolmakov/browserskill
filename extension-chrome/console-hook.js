/* Изолированная половина перехвата console.* — мир ISOLATED.
 *
 * Слушает приватный CustomEvent от console-hook-main.js и пачками отдаёт
 * записи в service worker. Пачками, а не по сообщению: одна запись в консоль
 * не должна стоить одного IPC.
 *
 * Имя канала обязано совпадать с console-hook-main.js.
 */
(() => {
  if (window.__ffmcpConsoleBridge) return;
  window.__ffmcpConsoleBridge = true;

  const CHANNEL = "ffmcp-console-v1";
  const FLUSH_MS = 250;
  const MAX_BATCH = 200;

  let batch = [];
  let timer = null;

  function flush() {
    timer = null;
    if (!batch.length) return;
    const items = batch;
    batch = [];
    try {
      // Service worker мог уснуть — промах отправки не должен ломать страницу.
      chrome.runtime.sendMessage({ __ffmcp: "console-batch", items }).catch(() => {});
    } catch (e) {}
  }

  document.addEventListener(CHANNEL, (ev) => {
    if (batch.length >= MAX_BATCH) return;
    try {
      batch.push(JSON.parse(String(ev.detail)));
    } catch {
      return;
    }
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  });
})();
