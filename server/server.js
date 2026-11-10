import express from "express";
import * as store from "./storage.js";

const PORT = process.env.PORT || 3000;
// Optional free phone push: set NTFY_TOPIC to any unguessable string, then
// subscribe to that topic in the ntfy app (https://ntfy.sh). No account needed.
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const NTFY_URL = process.env.NTFY_URL || "https://ntfy.sh";

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

// Phone push is held back until the self-view window has passed: if the "open"
// turns out to be the sender looking at their own thread, it has been erased
// by then and nothing is sent. One push per conversation per minute, because a
// single view of a long thread can fire several quoted pixels at once.
const lastPush = new Map();
function pushPhone(rec, openAt) {
  if (!NTFY_TOPIC) return;
  setTimeout(async () => {
    try {
      const list = await store.listEmails();
      const cur = list.find((e) => e.id === rec.id);
      if (!cur || !cur.opens.some((o) => o.at === openAt)) return; // retracted
      if (Date.now() - (lastPush.get(cur.key) || 0) < 60000) return;
      lastPush.set(cur.key, Date.now());
      await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
        method: "POST",
        headers: { Title: "Email opened", Tags: "eyes" },
        body: `${cur.thread} — ${cur.to} 開啟了你的信`,
      });
    } catch {}
  }, store.SELF_MS + 5000);
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 1) Extension registers an email when it is sent
app.post("/api/register", async (req, res) => {
  const { id, subject, to, thread, gthread, snippet, sender } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  await store.register({ id, subject, to, thread, gthread, snippet, sender });
  res.json({ ok: true });
});

// 2) The invisible tracking pixel
app.get("/t/:id.gif", async (req, res) => {
  const ua = req.get("user-agent") || "";
  const at = Date.now();
  const rec = await store.addOpen(req.params.id, {
    at,
    ua,
    viaProxy: /GoogleImageProxy/i.test(ua),
  });
  if (rec) pushPhone(rec, at); // fire-and-forget, delayed

  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.end(PIXEL);
});

// 3) The extension reports what the sender's own Gmail is displaying, so the
//    sender's own views are not counted and replies in the thread are noticed.
app.post("/api/view", async (req, res) => {
  const b = req.body || {};
  const changed = await store.reportView({
    ids: Array.isArray(b.ids) ? b.ids.map(String) : [],
    fresh: Array.isArray(b.fresh) ? b.fresh.map(String) : undefined,
    gthread: String(b.gthread || ""),
    thread: String(b.thread || ""),
    me: String(b.me || ""),
    lastFrom: String(b.lastFrom || ""),
    quoted: Array.isArray(b.quoted) ? b.quoted : [],
  });
  res.json({ ok: true, changed });
});

// 4) Manual "replied / not replied" override for a conversation
app.post("/api/replied", async (req, res) => {
  const { key, replied } = req.body || {};
  if (!key) return res.status(400).json({ error: "key required" });
  await store.setReplied(String(key), !!replied);
  res.json({ ok: true });
});

// 4b) Delete one conversation ({key}) or every record ({all:true})
app.post("/api/delete", async (req, res) => {
  const { key, all } = req.body || {};
  if (!key && all !== true) return res.status(400).json({ error: "key or all required" });
  await store.remove(key ? String(key) : "");
  res.json({ ok: true });
});

// 5) Data for the extension popup / dashboard / notifier
app.get("/api/emails", async (_req, res) => {
  res.json(await store.listEmails());
});
app.get("/api/threads", async (_req, res) => {
  res.json(await store.listThreads());
});

// 6) Dashboard
app.get("/", (_req, res) => {
  res.send(DASHBOARD);
});

const DASHBOARD = String.raw`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mail Tracker</title>
<style>
  body{font:15px/1.5 system-ui,"Microsoft JhengHei",sans-serif;margin:0;background:#f6f7f9;color:#1a1a1a}
  header{background:#1a73e8;color:#fff;padding:16px 24px;font-weight:600}
  main{max-width:860px;margin:24px auto;padding:0 16px}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
  .replied{background:#e8f0fe;color:#174ea6}.open{background:#e6f4ea;color:#137333}.unopen{background:#eee;color:#777}
  .muted{color:#999;font-size:12px}
  #groups{display:flex;flex-direction:column;gap:14px}
  .group{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
  .ghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid #eee;background:#fafafa}
  .gsubj{font-weight:600}
  .gcount{font-size:12px;color:#777;background:#eee;border-radius:999px;padding:1px 8px}
  .gright{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .gsub{padding:6px 14px;border-bottom:1px solid #f3f3f3;font-size:12px;color:#777}
  .msg{padding:10px 14px;border-bottom:1px solid #f3f3f3}
  .msg:last-child{border-bottom:0}
  .msg.old{opacity:.6}
  .msnip{font-size:14px;margin-bottom:4px}
  .meta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px}
  button{font:inherit;font-size:12px;border:1px solid #ccc;background:#fff;border-radius:6px;padding:2px 8px;cursor:pointer;color:#555}
  button:hover{background:#f1f3f4}
</style></head><body>
<header>📬 Mail Tracker</header>
<main>
  <p class="muted">每 5 秒自動更新。每個對話只看「你最新寄出的那一封」之後的狀態：已回覆 ／ 已讀未回 ／ 尚未開啟。你自己在 Gmail 看信不會被算成對方開啟。</p>
  <p><button id="clear">清空全部紀錄</button></p>
  <div id="groups"></div>
</main>
<script>
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmt(t){return t? new Date(t).toLocaleString():'—'}
function ago(t){
  const m=Math.max(0,Math.floor((Date.now()-t)/60000));
  if(m<60) return m+' 分鐘';
  if(m<1440) return Math.floor(m/60)+' 小時';
  return Math.floor(m/1440)+' 天';
}
function statusBadge(t){
  if(t.status==='replied') return '<span class="badge replied">✅ 對方已回覆'+(t.replyFrom?' · '+esc(t.replyFrom):'')+'</span>';
  if(t.status==='read') return '<span class="badge open">👀 已讀未回 · '+fmt(t.lastOpenAt)+'</span>';
  return '<span class="badge unopen">⏳ 尚未開啟</span>';
}
async function refresh(){
  const r = await fetch('/api/threads'); const list = await r.json();
  document.getElementById('groups').innerHTML = list.map(t=>{
    const head = '<div class="ghead">'+
      '<span class="gsubj">'+esc(t.subject)+'</span>'+
      (t.messages.length>1? '<span class="gcount">'+t.messages.length+' 封</span>':'')+
      '<span class="gright">'+statusBadge(t)+
      '<button data-key="'+esc(t.key)+'" data-replied="'+(t.status==='replied'?0:1)+'">'+
        (t.status==='replied'?'取消已回覆':'標記已回覆')+'</button>'+
      '<button data-del="'+esc(t.key)+'" title="刪除此對話的紀錄">刪除</button></span>'+
      '</div>';
    const sub = '<div class="gsub">'+esc(t.to)+' · 最新一封寄出 '+fmt(t.sentAt)+
      (t.status==='replied'?'':' · 已等待 '+ago(t.sentAt))+'</div>';
    const rows = t.messages.map((e,i)=>{
      const last = e.opens[e.opens.length-1];
      const st = (e.repliedAt? '<span class="badge replied">已回覆</span>':'')+
        (e.openCount? '<span class="badge open">開啟 '+e.openCount+' 次</span>':'<span class="badge unopen">未開啟</span>');
      const label = e.snippet? esc(e.snippet) : '<span class="muted">(無內文摘要)</span>';
      return '<div class="msg'+(i? ' old':'')+'"><div class="msnip">'+label+'</div>'+
        '<div class="meta"><span class="muted">寄出 '+fmt(e.createdAt)+'</span>'+st+
        (last? '<span class="muted">最後開啟 '+fmt(last.at)+'</span>':'')+'</div></div>';
    }).join('');
    return '<div class="group">'+head+sub+rows+'</div>';
  }).join('') || '<p class="muted">尚無資料</p>';
}
const postJson = (u,b)=>fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
document.getElementById('clear').addEventListener('click', async ()=>{
  if(!confirm('確定要刪除全部追蹤紀錄嗎？無法復原。')) return;
  await postJson('/api/delete',{all:true}); refresh();
});
document.getElementById('groups').addEventListener('click', async ev=>{
  const d = ev.target.closest('button[data-del]');
  if(d){ if(confirm('刪除這個對話的追蹤紀錄？')){ await postJson('/api/delete',{key:d.dataset.del}); refresh(); } return; }
  const b = ev.target.closest('button[data-key]'); if(!b) return;
  await fetch('/api/replied',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:b.dataset.key, replied:b.dataset.replied==='1'})});
  refresh();
});
refresh(); setInterval(refresh,5000);
</script></body></html>`;

store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Mail tracker running → http://localhost:${PORT}`);
    if (NTFY_TOPIC) console.log(`Phone push enabled → ${NTFY_URL}/${NTFY_TOPIC}`);
  });
});
