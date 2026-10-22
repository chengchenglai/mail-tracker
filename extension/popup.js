const SERVER = "https://mailtrack-server.onrender.com"; // keep in sync with content.js

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function render() {
  const list = document.getElementById("list");
  try {
    const r = await fetch(`${SERVER}/api/emails`);
    const data = await r.json();
    if (!data.length) {
      list.innerHTML = '<li class="empty">尚無追蹤的郵件</li>';
      return;
    }
    list.innerHTML = data
      .map((e) => {
        const last = e.opens[e.opens.length - 1];
        const badge = e.openCount
          ? `<span class="badge open">已讀 ${e.openCount}</span>`
          : '<span class="badge unopen">未讀</span>';
        const when = last ? new Date(last.at).toLocaleString() : "";
        const snip = e.snippet ? `<div class="to">${esc(e.snippet)}</div>` : "";
        return `<li>
          <div class="subj">${esc(e.thread || e.subject)}</div>
          ${snip}
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
