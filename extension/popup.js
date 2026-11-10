const SERVER = "https://mailtrack-server.onrender.com"; // keep in sync with content.js

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function ago(t) {
  const m = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (m < 60) return m + " 分鐘";
  if (m < 1440) return Math.floor(m / 60) + " 小時";
  return Math.floor(m / 1440) + " 天";
}

// One row per conversation, judged by the newest mail I sent in it.
async function render() {
  const list = document.getElementById("list");
  try {
    const r = await fetch(`${SERVER}/api/threads`);
    const data = await r.json();
    if (!data.length) {
      list.innerHTML = '<li class="empty">尚無追蹤的郵件</li>';
      return;
    }
    list.innerHTML = data
      .map((t) => {
        let badge, when;
        if (t.status === "replied") {
          badge = '<span class="badge replied">✅ 已回覆</span>';
          when = new Date(t.repliedAt).toLocaleString();
        } else if (t.status === "read") {
          badge = '<span class="badge open">👀 已讀未回</span>';
          when = "開啟於 " + new Date(t.lastOpenAt).toLocaleString();
        } else {
          badge = '<span class="badge unopen">⏳ 尚未開啟</span>';
          when = "已等待 " + ago(t.sentAt);
        }
        const count = t.messages.length > 1 ? ` <span class="to">(${t.messages.length} 封)</span>` : "";
        const snip = t.messages[0].snippet;
        return `<li>
          <div class="subj">${esc(t.subject)}${count}</div>
          <div class="to">${esc(t.to)}</div>
          ${snip ? `<div class="to">${esc(snip)}</div>` : ""}
          <div class="row">${badge}<span class="to">${when}</span></div>
        </li>`;
      })
      .join("");
  } catch {
    list.innerHTML = '<li class="empty">無法連線伺服器<br>請先啟動 server</li>';
  }
}

render();
setInterval(render, 4000);
