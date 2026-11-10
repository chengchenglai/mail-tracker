// Storage layer: uses Postgres when DATABASE_URL is set (Render / Supabase /
// Neon), otherwise falls back to a local JSON file for offline testing.
//
// Each backend only knows how to load / fetch / upsert whole records; all the
// tracking rules (grace window, self-view suppression, reply detection, thread
// grouping) live once, below, in plain JS.
//
// Record shape:
//   { id, subject, to, thread, gthread, snippet, createdAt, opens: [{at,ua,viaProxy}],
//     repliedAt, replyFrom, suppressUntil }
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
    suppressUntil: Number(r.suppressUntil) || 0,
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
    suppressUntil: r.suppress_until,
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
      "suppress_until BIGINT",
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
  async put(r) {
    await pg.query(
      `INSERT INTO emails (id, subject, recipient, created_at, opens, thread, snippet,
                           gthread, replied_at, reply_from, suppress_until)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         subject=$2, recipient=$3, created_at=$4, opens=$5::jsonb, thread=$6, snippet=$7,
         gthread=$8, replied_at=$9, reply_from=$10, suppress_until=$11`,
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
        r.suppressUntil,
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

// Opens this soon after sending are the sender's own Gmail rendering the image
// or a delivery-time prefetch — not the recipient.
const GRACE_MS = 20000;
// When the sender's own Gmail reports it is displaying a tracked message, hits
// this close to that moment (before or after) are the sender's, not the
// recipient's.
export const SELF_MS = 30000;
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

export function register({ id, subject, to, thread, gthread, snippet }) {
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
    if (open.at < rec.suppressUntil) return null; // sender is looking at it
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
//   ids      tracked pixels currently rendered on screen (→ those hits are mine)
//   gthread  Gmail thread id of the open conversation
//   thread   its normalized subject
//   me       the sender's own address
//   lastFrom who wrote the newest message in the conversation
//   quoted   [{id, from}] someone else's message that carries my pixel, i.e.
//            they replied on top of that mail
export function reportView({ ids = [], gthread = "", thread = "", me = "", lastFrom = "", quoted = [] }) {
  return serial(async () => {
    const now = Date.now();
    me = me.toLowerCase();
    lastFrom = lastFrom.toLowerCase();
    const seen = new Set(ids);
    const quotedBy = new Map(quoted.map((q) => [q.id, String(q.from || "").toLowerCase()]));
    const otherRepliedLast = !!me && !!lastFrom && lastFrom !== me;
    let changed = 0;

    for (const rec of await be.all()) {
      let dirty = false;

      if (seen.has(rec.id)) {
        const kept = rec.opens.filter((o) => o.at < now - SELF_MS);
        if (kept.length !== rec.opens.length) rec.opens = kept;
        rec.suppressUntil = now + SELF_MS;
        if (gthread && !rec.gthread) rec.gthread = gthread;
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
