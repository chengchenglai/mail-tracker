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

async function pushPhone(rec) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`${NTFY_URL}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: "Email opened", Tags: "eyes" },
      body: `${rec.subject} — ${rec.to} 開啟了你的信`,
    });
  } catch {}
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
  const { id, subject, to, thread, snippet } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  await store.register(
    id,
    subject || "(no subject)",
    to || "(unknown)",
    thread || subject || "(no subject)",
    snippet || ""
  );
  res.json({ ok: true });
});

// 2) The invisible tracking pixel
app.get("/t/:id.gif", async (req, res) => {
  const ua = req.get("user-agent") || "";
  const viaProxy = /GoogleImageProxy/i.test(ua);
  const rec = await store.addOpen(req.params.id, {
    at: Date.now(),
    ua,
    viaProxy,
  });
  if (rec) pushPhone(rec); // fire-and-forget phone push

  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.end(PIXEL);
});

// 3) Data for the extension popup / dashboard
app.get("/api/emails", async (_req, res) => {
  res.json(await store.listEmails());
});

// 4) Dashboard
app.get("/", (_req, res) => {
  res.send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mail Tracker</title>
<style>
  body{font:15px/1.5 system-ui,"Microsoft JhengHei",sans-serif;margin:0;background:#f6f7f9;color:#1a1a1a}
  header{background:#1a73e8;color:#fff;padding:16px 24px;font-weight:600}
  main{max-width:860px;margin:24px auto;padding:0 16px}
  table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #eee;font-size:14px}
  th{background:#fafafa;color:#555}
  .badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
  .open{background:#e6f4ea;color:#137333}.unopen{background:#eee;color:#777}
  .muted{color:#999;font-size:12px}
</style></head><body>
<header>📬 Mail Tracker</header>
<main>
  <p class="muted">每 5 秒自動更新。同一對話串的信件會收在一組。對話串裡「對方是否開啟此對話」才是可靠訊號——詳見每組標題的狀態。</p>
  <div id="groups"></div>
</main>
<script>
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function fmt(t){return t? new Date(t).toLocaleString():'—'}

async function refresh(){
  const r = await fetch('/api/emails'); const list = await r.json();
  // group by thread
  const groups = {};
  for(const e of list){
    const k = e.thread || e.subject || '(no subject)';
    (groups[k] = groups[k] || []).push(e);
  }
  // order groups by most recent activity (send or open)
  const activity = g => Math.max(...g.map(e=>Math.max(e.createdAt, ...(e.opens.map(o=>o.at).concat([0])))));
  const keys = Object.keys(groups).sort((a,b)=>activity(groups[b])-activity(groups[a]));

  document.getElementById('groups').innerHTML = keys.map(k=>{
    const msgs = groups[k].sort((a,b)=>b.createdAt-a.createdAt); // newest first
    // thread-level: latest open time across all my messages in this thread
    const lastOpen = Math.max(0, ...msgs.flatMap(e=>e.opens.map(o=>o.at)));
    const opened = lastOpen>0;
    const head = '<div class="ghead">'+
      '<span class="gsubj">'+esc(k)+'</span>'+
      (msgs.length>1? '<span class="gcount">'+msgs.length+' 封</span>':'')+
      (opened? '<span class="badge open">對方已開啟此對話 · '+fmt(lastOpen)+'</span>'
             : '<span class="badge unopen">尚未開啟</span>')+
      '</div>';
    const rows = msgs.map(e=>{
      const last = e.opens[e.opens.length-1];
      const st = e.openCount? '<span class="badge open">已讀 '+e.openCount+'</span>':'<span class="badge unopen">未讀</span>';
      const label = e.snippet? esc(e.snippet) : '<span class="muted">(無內文摘要)</span>';
      return '<div class="msg"><div class="msnip">'+label+'</div>'+
        '<div class="meta"><span class="muted">寄出 '+fmt(e.createdAt)+'</span>'+st+
        '<span class="muted">最後開啟 '+fmt(last&&last.at)+'</span></div></div>';
    }).join('');
    return '<div class="group">'+head+rows+'</div>';
  }).join('') || '<p class="muted">尚無資料</p>';
}
refresh(); setInterval(refresh,5000);
</script>
<style>
  #groups{display:flex;flex-direction:column;gap:14px}
  .group{background:#fff;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden}
  .ghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid #eee;background:#fafafa}
  .gsubj{font-weight:600}
  .gcount{font-size:12px;color:#777;background:#eee;border-radius:999px;padding:1px 8px}
  .ghead .badge{margin-left:auto}
  .msg{padding:10px 14px;border-bottom:1px solid #f3f3f3}
  .msg:last-child{border-bottom:0}
  .msnip{font-size:14px;margin-bottom:4px}
  .meta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px}
</style></body></html>`);
});

store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Mail tracker running → http://localhost:${PORT}`);
    if (NTFY_TOPIC) console.log(`Phone push enabled → ${NTFY_URL}/${NTFY_TOPIC}`);
  });
});
