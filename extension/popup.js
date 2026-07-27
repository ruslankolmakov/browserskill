(async () => {
  const bg = await browser.runtime.getBackgroundPage();
  const s = bg.__ffmcp;
  const st = document.getElementById("status");
  const connected = s.connected();
  st.textContent = connected ? "подключён" : "нет связи";
  st.className = "v " + (connected ? "on" : "off");
  const target = await s.targetWindow();
  const current = await browser.windows.getCurrent();
  const tgt = document.getElementById("target");
  tgt.textContent = target === null ? "любое" : target === current.id ? `${target} (это)` : String(target);
  tgt.className = "v " + (target === null ? "" : "on");
  document.getElementById("tabs").textContent = (await browser.tabs.query({})).length;
  document.getElementById("console").textContent = s.consoleLog.length;
  document.getElementById("net").textContent = s.networkLog.length;
  document.getElementById("reload").addEventListener("click", () => {
    s.reconnect();
    window.close();
  });
})();
