/* Popup расширения. В MV3 нет getBackgroundPage, поэтому состояние берём
 * сообщениями у service worker. */

const ask = (cmd, extra = {}) => chrome.runtime.sendMessage({ __browserskill: "popup", cmd, ...extra });

const box = document.getElementById("approvals");
let current = null;

function setStatus(text, cls) {
  const st = document.getElementById("status");
  st.textContent = text;
  st.className = "v " + (cls || "");
}

async function render() {
  let s;
  try {
    s = await ask("state");
  } catch (e) {
    setStatus("нет ответа воркера", "off");
    return;
  }
  if (!s) {
    setStatus("пустой ответ", "off");
    return;
  }
  if (s.error) {
    setStatus("ошибка", "off");
    return;
  }

  // Очередь подтверждений рисуем первой и в отрыве от остального: сломавшийся
  // счётчик вкладок не должен оставить пользователя без кнопок доступа.
  renderApprovals(s.approvals || []);

  setStatus(s.connected ? "подключён" : "нет связи", s.connected ? "on" : "off");

  const tgt = document.getElementById("target");
  if (s.target === null) {
    tgt.textContent = "любое";
    tgt.className = "v";
  } else {
    let here = false;
    try {
      here = (await chrome.windows.getCurrent()).id === s.target;
    } catch (e) {}
    tgt.textContent = here ? `${s.target} (это)` : String(s.target);
    tgt.className = "v on";
  }

  document.getElementById("tabs").textContent = s.tabs === null ? "?" : s.tabs;
  document.getElementById("console").textContent = s.consoleCount;
  document.getElementById("net").textContent = s.networkCount;
}

function renderApprovals(list) {
  // Перерисовываем, только когда очередь изменилась, — иначе опрос раз в
  // секунду сбрасывал бы нажатие на кнопку.
  const key = list.map((a) => a.reqId).join(",");
  if (key === current) return;
  current = key;

  box.textContent = "";
  for (const a of list) {
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
      b.addEventListener("click", async () => {
        await ask("decide", { reqId: a.reqId, decision, scope });
        current = null;
        render();
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

document.getElementById("reload").addEventListener("click", async () => {
  await ask("reconnect");
  window.close();
});

render();
// Пока popup открыт, подхватываем новые запросы.
const poll = setInterval(render, 1000);
window.addEventListener("unload", () => clearInterval(poll));
