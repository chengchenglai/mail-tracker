// Storage layer: uses Postgres when DATABASE_URL is set (Render / Supabase /
// Neon), otherwise falls back to a local JSON file for offline testing.
//
// Each backend only knows how to load / fetch / upsert whole records; all the
// tracking rules (grace window, self-view suppression, reply detection, thread
// grouping) live once, below, in plain JS.
//
// Record shape:
//   { id, subject, to, thread, gthread, snippet, createdAt, opens: [{at,ua,viaProxy}],
//     repliedAt, replyFrom, sender }
//   sender  = the Gmail account that sent it; only that account's own views
//             are cancelled / used for reply detection
//   thread  = subject with Re:/Fwd: stripped
//   gthread = Gmail's own thread id (known for replies, learned later for the
//             first message of a conversation)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data.json");
const USE_PG = !!process.env.DATABASE_URL;

let pg = null; // lazy-loaded pg pool

function normalize(r) {
  return {
    id: r.id,
    subject: r.subject || "(no subject)",
    to: r.to || "(unknown)",
    thread: r.thread || r.subject || "(no subject)",
    gthread: r.gthread || "",
    snippet: r.snippet || "",
    createdAt: Number(r.createdAt) || 0,
    opens: r.opens || [],
    repliedAt: Number(r.repliedAt) || 0,
    replyFrom: r.replyFrom || "",
    sender: (r.sender || "").toLowerCase(),
  };
}

// ---------- Postgres backend ----------
const fromRow = (r) =>
  normalize({
    id: r.id,
    subject: r.subject,
    to: r.recipient,
    thread: r.thread,
    gthread: r.gthread,
    snippet: r.snippet,
    createdAt: r.created_at,
    opens: r.opens,
    repliedAt: r.replied_at,
    replyFrom: r.reply_from,
    sender: r.sender,
  });

const pgBackend = {
  async init() {
    const { default: Pkg } = await import("pg");
    const { Pool } = Pkg;
    pg = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase / Neon require SSL
    });
    await pg.query(`
      CREATE TABLE IF NOT EXISTS emails (
        id         TEXT PRIMARY KEY,
        subject    TEXT,
        recipient  TEXT,
        created_at BIGINT,
        opens      JSONB NOT NULL DEFAULT '[]'::jsonb
      );
    `);
    // added later — safe to run every boot
    for (const col of [
      "thread TEXT",
      "snippet TEXT",
      "gthread TEXT",
      "replied_at BIGINT",
      "reply_from TEXT",
      "sender TEXT",
    ]) {
      await pg.query(`ALTER TABLE emails ADD COLUMN IF NOT EXISTS ${col};`);
    }
    console.log("[storage] Postgres connected");
  },
  async all() {
    const { rows } = await pg.query(`SELECT * FROM emails`);
    return rows.map(fromRow);
  },
  async get(id) {
    const { rows } = await pg.query(`SELECT * FROM emails WHERE id=$1`, [id]);
    return rows.length ? fromRow(rows[0]) : null;
  },
  async del(id) {
    await pg.query("DELETE FROM emails WHERE id=$1", [id]);
  },
  async clear() {
    await pg.query("DELETE FROM emails");
  },
  async put(r) {
    await pg.query(
      `INSERT INTO emails (id, subject, recipient, created_at, opens, thread, snippet,
                           gthread, replied_at, reply_from, sender)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         subject=$2, recipient=$3, created_at=$4, opens=$5::jsonb, thread=$6, snippet=$7,
         gthread=$8, replied_at=$9, reply_from=$10, sender=$11`,
      [
        r.id,
        r.subject,
        r.to,
        r.createdAt,
        JSON.stringify(r.opens),
        r.thread,
        r.snippet,
        r.gthread,
        r.repliedAt,
        r.replyFrom,
        r.sender,
      ]
    );
  },
};

// ---------- JSON backend ----------
function loadJson() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { emails: {} };
  }
}
const jsonBackend = {
  async init() {
    console.log("[storage] using local JSON file (no DATABASE_URL set)");
  },
  async all() {
    return Object.entries(loadJson().emails).map(([id, e]) => normalize({ ...e, id }));
  },
  async get(id) {
    const e = loadJson().emails[id];
    return e ? normalize({ ...e, id }) : null;
  },
  async del(id) {
    const db = loadJson();
    delete db.emails[id];
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  },
  async clear() {
    fs.writeFileSync(DB_FILE, JSON.stringify({ emails: {} }, null, 2));
  },
  async put(r) {
    const db = loadJson();
    const { id, ...rest } = r;
    db.emails[id] = rest;
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  },
};

const be = USE_PG ? pgBackend : jsonBackend;

// Every mutation is read-modify-write, and a self-view report races the very
// pixel hit it is meant to cancel — so run mutations strictly one at a time.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ---------- rules ----------

// Opens this soon after sending cannot be the recipient yet (the sender's own
// Gmail rendering the just-sent mail is handled separately, below).
const GRACE_MS = 8000;
// Each time the sender's own Gmail renders a tracked pixel it causes exactly
// one hit, arriving within moments of the extension's report. So a report
// cancels ONE hit per rendered pixel: the one that just landed, or else the
// next one within this window. Nothing else is discarded — the recipient
// opening the mail seconds after it was sent must still count.
export const SELF_MS = 10000;
const selfCredits = new Map(); // id → { n, until }
// A message registered this recently can't have been answered yet; guards the
// moment right after Send when the thread view still ends with the other side.
const REPLY_GUARD_MS = 30000;

const addrs = (s) => (String(s || "").toLowerCase().match(/[^\s,;<>"']+@[^\s,;<>"']+/g) || []);
const sharesAddr = (a, b) => {
  const B = new Set(addrs(b));
  return addrs(a).some((x) => B.has(x));
};

export function threadKey(r) {
  return r.gthread || `${r.thread}|${addrs(r.to).sort().join(",")}`;
}

export const init = () => be.init();

export function register({ id, subject, to, thread, gthread, snippet, sender }) {
  return serial(async () => {
    const now = Date.now();
    const prev = await be.get(id);
    const rec = normalize({
      ...(prev || {}),
      id,
      subject,
      to,
      thread: thread || subject,
      gthread: gthread || (prev && prev.gthread) || "",
      snippet,
      sender: sender || (prev && prev.sender) || "",
      createdAt: now, // re-send after "Undo" restarts the grace window
    });
    await be.put(rec);

    // A reply tells us the Gmail thread id; hand it to the earlier messages of
    // the same conversation (same subject, overlapping recipients) that were
    // sent as a fresh compose and so never had one.
    if (rec.gthread) {
      for (const o of await be.all()) {
        if (o.id !== id && !o.gthread && o.thread === rec.thread && sharesAddr(o.to, rec.to)) {
          o.gthread = rec.gthread;
          await be.put(o);
        }
      }
    }
  });
}

// Returns the updated record if an open was recorded (for notifications),
// or null if ignored (unknown id, grace window, self-view, or deduped burst).
export function addOpen(id, open) {
  return serial(async () => {
    const rec = await be.get(id);
    if (!rec) return null;
    if (open.at - rec.createdAt < GRACE_MS) return null; // grace
    const credit = selfCredits.get(id);
    if (credit && credit.n > 0 && open.at < credit.until) {
      credit.n--; // the sender's own render, announced by the extension
      return null;
    }
    const last = rec.opens[rec.opens.length - 1];
    if (last && open.at - last.at < 5000) return null; // dedupe
    rec.opens.push(open);
    await be.put(rec);
    return rec;
  });
}

function markReplied(rec, from, at) {
  rec.repliedAt = at;
  rec.replyFrom = from || "";
}

// The extension reports what the sender's own Gmail is showing:
//   ids      tracked pixels currently on screen
//   fresh    ids of pixels rendered since the last report, one entry per
//            render (→ that many hits are mine)
//   gthread  Gmail thread id of the open conversation
//   thread   its normalized subject
//   me       the sender's own address
//   lastFrom who wrote the newest message in the conversation
//   quoted   [{id, from}] someone else's message that carries my pixel, i.e.
//            they replied on top of that mail
export function reportView({ ids = [], fresh = ids, gthread = "", thread = "", me = "", lastFrom = "", quoted = [] }) {
  return serial(async () => {
    const now = Date.now();
    me = me.toLowerCase();
    lastFrom = lastFrom.toLowerCase();
    const seen = new Set(ids);
    const renders = new Map(); // id → how many times my Gmail just rendered it
    for (const id of fresh) renders.set(id, (renders.get(id) || 0) + 1);
    const quotedBy = new Map(quoted.map((q) => [q.id, String(q.from || "").toLowerCase()]));
    const otherRepliedLast = !!me && !!lastFrom && lastFrom !== me;
    let changed = 0;

    for (const rec of await be.all()) {
      // Another account in the same browser (e.g. the recipient's, when
      // testing) looking at this mail is a real open, not a self-view.
      if (rec.sender && me && rec.sender !== me) continue;
      let dirty = false;

      let mine = renders.get(rec.id) || 0;
      while (mine > 0 && rec.opens.length && rec.opens[rec.opens.length - 1].at >= now - SELF_MS) {
        rec.opens.pop(); // my hit already landed
        mine--;
        dirty = true;
      }
      if (mine > 0) selfCredits.set(rec.id, { n: mine, until: now + SELF_MS }); // still on its way
      if (seen.has(rec.id) && gthread && !rec.gthread) {
        rec.gthread = gthread;
        dirty = true;
      }

      if (!rec.repliedAt && now - rec.createdAt > REPLY_GUARD_MS) {
        const q = quotedBy.get(rec.id);
        if (q && q !== me) {
          markReplied(rec, q, now);
          dirty = true;
        } else if (
          otherRepliedLast &&
          (seen.has(rec.id) ||
            (gthread && rec.gthread === gthread) ||
            (!rec.gthread && thread && rec.thread === thread && addrs(rec.to).includes(lastFrom)))
        ) {
          markReplied(rec, lastFrom, now);
          dirty = true;
        }
      }

      if (dirty) {
        await be.put(rec);
        changed++;
      }
    }
    return changed;
  });
}

// Manual override from the dashboard (e.g. the reply was read on the phone,
// where the extension can't see it).
export function setReplied(key, replied) {
  return serial(async () => {
    const now = Date.now();
    for (const rec of await be.all()) {
      if (threadKey(rec) !== key) continue;
      if (replied && !rec.repliedAt) markReplied(rec, "", now);
      else if (!replied && rec.repliedAt) markReplied(rec, "", 0);
      else continue;
      await be.put(rec);
    }
  });
}

// Delete one conversation's records, or everything when no key is given.
export function remove(key) {
  return serial(async () => {
    if (!key) return be.clear();
    for (const rec of await be.all()) if (threadKey(rec) === key) await be.del(rec.id);
  });
}

export async function listEmails() {
  return (await be.all())
    .map((r) => ({ ...r, key: threadKey(r), openCount: r.opens.length }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// One entry per conversation, judged by its NEWEST message — in a long
// back-and-forth, that is the only one whose status still matters:
//   replied  the other side answered after my newest message
//   read     not answered, but some pixel of this conversation fired after my
//            newest message was sent (opening the conversation shows it)
//   sent     nothing since my newest message
export async function listThreads() {
  const groups = new Map();
  for (const e of await listEmails()) {
    if (!groups.has(e.key)) groups.set(e.key, []);
    groups.get(e.key).push(e); // already newest first
  }
  const out = [];
  for (const [key, messages] of groups) {
    const latest = messages[0];
    const opensSince = messages
      .flatMap((m) => m.opens.map((o) => o.at))
      .filter((at) => at > latest.createdAt);
    const lastOpenAt = opensSince.length ? Math.max(...opensSince) : 0;
    const status = latest.repliedAt ? "replied" : lastOpenAt ? "read" : "sent";
    out.push({
      key,
      subject: latest.thread,
      to: latest.to,
      status,
      sentAt: latest.createdAt,
      lastOpenAt,
      openCount: opensSince.length,
      repliedAt: latest.repliedAt,
      replyFrom: latest.replyFrom,
      activity: Math.max(latest.createdAt, lastOpenAt, latest.repliedAt),
      messages,
    });
  }
  return out.sort((a, b) => b.activity - a.activity);
}
