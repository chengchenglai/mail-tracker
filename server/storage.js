// Storage layer: uses Postgres when DATABASE_URL is set (Render / Supabase /
// Neon), otherwise falls back to a local JSON file for offline testing.
// Same API either way, so server.js never changes.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, "data.json");
const USE_PG = !!process.env.DATABASE_URL;

let pg = null; // lazy-loaded pg pool

// ---------- Postgres backend ----------
async function initPg() {
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
  console.log("[storage] Postgres connected");
}

// ---------- JSON backend ----------
function loadJson() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { emails: {} };
  }
}
function saveJson(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- public API ----------
export async function init() {
  if (USE_PG) await initPg();
  else console.log("[storage] using local JSON file (no DATABASE_URL set)");
}

export async function register(id, subject, recipient) {
  const now = Date.now();
  if (USE_PG) {
    await pg.query(
      `INSERT INTO emails (id, subject, recipient, created_at, opens)
       VALUES ($1,$2,$3,$4,'[]'::jsonb)
       ON CONFLICT (id) DO UPDATE SET subject=$2, recipient=$3`,
      [id, subject, recipient, now]
    );
  } else {
    const db = loadJson();
    db.emails[id] = { subject, to: recipient, createdAt: now, opens: [] };
    saveJson(db);
  }
}

// Returns the updated record if an open was recorded (for notifications),
// or null if ignored (unknown id or deduped burst).
export async function addOpen(id, open) {
  if (USE_PG) {
    const { rows } = await pg.query(`SELECT * FROM emails WHERE id=$1`, [id]);
    if (!rows.length) return null;
    const rec = rows[0];
    const opens = rec.opens || [];
    const last = opens[opens.length - 1];
    if (last && open.at - last.at < 5000) return null; // dedupe
    opens.push(open);
    await pg.query(`UPDATE emails SET opens=$2 WHERE id=$1`, [
      id,
      JSON.stringify(opens),
    ]);
    return { id, subject: rec.subject, to: rec.recipient, opens };
  } else {
    const db = loadJson();
    const rec = db.emails[id];
    if (!rec) return null;
    const last = rec.opens[rec.opens.length - 1];
    if (last && open.at - last.at < 5000) return null;
    rec.opens.push(open);
    saveJson(db);
    return { id, subject: rec.subject, to: rec.to, opens: rec.opens };
  }
}

export async function listEmails() {
  if (USE_PG) {
    const { rows } = await pg.query(
      `SELECT * FROM emails ORDER BY created_at DESC`
    );
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      to: r.recipient,
      createdAt: Number(r.created_at),
      opens: r.opens || [],
      openCount: (r.opens || []).length,
    }));
  } else {
    const db = loadJson();
    return Object.entries(db.emails)
      .map(([id, e]) => ({ id, ...e, openCount: e.opens.length }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}
