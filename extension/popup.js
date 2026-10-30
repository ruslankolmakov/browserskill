(async () => {
  const bg = await browser.runtime.getBackgroundPage();
  const s = bg.__browserskill;
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

  const box = document.getElementById("approvals");
  function renderApprovals() {
    box.textContent = "";
    for (const a of s.pendingApprovals()) {
      const c = a.client || {};
      const card = document.createElement("div");
      card.className = "approval";

      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "🔐 " + (c.name || "процесс") + (c.pid ? " · pid " + c.pid : "");
      card.appendChild(who);

      if (c.argv) {
        const cmd = document.createElement("div");
        cmd.className = "cmd";
        cmd.textContent = c.argv;
        card.appendChild(cmd);
      }

      const btn = (label, decision, scope, cls) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = cls;
        b.addEventListener("click", () => {
          s.decideApproval(a.reqId, decision, scope);
          renderApprovals();
        });
        card.appendChild(b);
      };
      btn("Разрешить это подключение", "approve", "connection", "ok");
      btn("Разрешить на эту сессию", "approve", "session", "ok");
      btn("Разрешить навсегда", "approve", "forever", "ok");
      btn("Отклонить", "deny", null, "no");
      box.appendChild(card);
    }
  }
  renderApprovals();
  // Пока popup открыт, подхватываем новые запросы.
  const poll = setInterval(renderApprovals, 1000);
  window.addEventListener("unload", () => clearInterval(poll));
})();
