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
  const { id, subject, to } = req.body || {};
  if (!id) return res.status(400).json({ error: "id required" });
  await store.register(id, subject || "(no subject)", to || "(unknown)");
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
  <p class="muted">每 5 秒自動更新。開信偵測受 Gmail 圖片代理快取影響，第一次開啟最準。</p>
  <table><thead><tr><th>主旨</th><th>收件人</th><th>狀態</th><th>開啟次數</th><th>最後開啟</th></tr></thead>
  <tbody id="rows"></tbody></table>
</main>
<script>
async function refresh(){
  const r = await fetch('/api/emails'); const list = await r.json();
  document.getElementById('rows').innerHTML = list.map(e=>{
    const last = e.opens[e.opens.length-1];
    const st = e.openCount? '<span class="badge open">已讀</span>':'<span class="badge unopen">未讀</span>';
    return '<tr><td>'+esc(e.subject)+'</td><td>'+esc(e.to)+'</td><td>'+st+
      '</td><td>'+e.openCount+'</td><td class="muted">'+(last? new Date(last.at).toLocaleString():'—')+'</td></tr>';
  }).join('') || '<tr><td colspan="5" class="muted">尚無資料</td></tr>';
}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
refresh(); setInterval(refresh,5000);
</script></body></html>`);
});

store.init().then(() => {
  app.listen(PORT, () => {
    console.log(`Mail tracker running → http://localhost:${PORT}`);
    if (NTFY_TOPIC) console.log(`Phone push enabled → ${NTFY_URL}/${NTFY_TOPIC}`);
  });
});
