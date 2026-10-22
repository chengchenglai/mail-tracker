// Background worker: polls the server and fires a desktop notification the
// moment a tracked email gets a new open. State is kept in chrome.storage so
// the MV3 worker can be killed and restarted without re-notifying.

const SERVER = "https://mailtrack-server.onrender.com"; // keep in sync with content.js

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

  for (const e of list) {
    const count = e.openCount || 0;
    const prev = seen[e.id] || 0;
    // Only notify for opens that are NEW to us (prev < count) and avoid
    // notifying for historical backlog the first time we ever see an id.
    if (e.id in seen && count > prev) {
      const last = e.opens[e.opens.length - 1];
      // skip very old opens (e.g. first-ever sync) and proxy prefetch noise
      if (last && now - last.at < 10 * 60 * 1000) {
        notify(e, count);
      }
    }
    if (prev !== count) {
      seen[e.id] = count;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ seen });
}

function notify(email, count) {
  chrome.notifications.create(`${email.id}-${count}`, {
    type: "basic",
    iconUrl: "icon128.png",
    title: "📬 信件被開啟了",
    message: `${email.subject}\n${email.to}`,
    contextMessage: count > 1 ? `第 ${count} 次開啟` : "首次開啟",
    priority: 2,
  });
}
