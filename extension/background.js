// Background worker: polls the server and fires a desktop notification when a
// tracked conversation gets a new open. State is kept in chrome.storage so the
// MV3 worker can be killed and restarted without re-notifying.

const SERVER = "https://mailtrack-server.onrender.com"; // keep in sync with content.js

// An open only counts once it has survived this long: within that window the
// server may still retract it as the sender's own view of the thread.
const SETTLE_MS = 20000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 1 }); // min allowed = 1
  poll();
});
chrome.runtime.onStartup.addListener(() => poll());
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "poll") poll();
});

async function poll() {
  let list;
  try {
    const r = await fetch(`${SERVER}/api/emails`);
    list = await r.json();
  } catch {
    return; // server offline; try again next alarm
  }

  const { seen = {} } = await chrome.storage.local.get("seen");
  let changed = false;
  const now = Date.now();
  const notified = new Set(); // one notification per conversation per poll

  for (const e of list) {
    const settled = e.opens.filter((o) => now - o.at > SETTLE_MS);
    const count = settled.length;
    const prev = seen[e.id] || 0;
    // Only notify for opens that are NEW to us (prev < count), never for the
    // backlog the first time we see an id, never for stale opens, and not for
    // conversations the other side has already answered.
    if (e.id in seen && count > prev && !e.repliedAt && !notified.has(e.key)) {
      const last = settled[settled.length - 1];
      if (now - last.at < 10 * 60 * 1000) {
        notified.add(e.key);
        notify(e, last.at);
      }
    }
    if (prev !== count || !(e.id in seen)) {
      seen[e.id] = count;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ seen });
}

function notify(email, at) {
  chrome.notifications.create(`${email.key}-${at}`, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "📬 信件被開啟了",
    message: `${email.thread}\n${email.to}`,
    contextMessage: new Date(at).toLocaleTimeString(),
    priority: 2,
  });
}
