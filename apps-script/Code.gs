// Mail Tracker — check marks in the Gmail mobile app.
//
// The phone app cannot run the Chrome extension, but it does show Gmail labels.
// This script runs inside YOUR Google account (script.google.com), asks the
// tracking server for the state of each conversation once a minute, and keeps
// two labels in sync:
//     ✓    sent, not opened yet
//     ✓✓   opened (or answered) by the other side
//
// Setup: see README, "手機 Gmail App 顯示勾勾". Run `install` once.

const SERVER = "https://mailtrack-server.onrender.com"; // same as the extension
const LABEL_SENT = "✓";
const LABEL_READ = "✓✓";
const MAX_AGE_DAYS = 30; // conversations idle longer than this are left alone

// Run once by hand: authorizes the script and starts the every-minute sync.
function install() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("sync").timeBased().everyMinutes(1).create();
  sync();
}

// Run by hand to stop syncing and remove both labels everywhere.
function uninstall() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  [LABEL_SENT, LABEL_READ].forEach((name) => {
    const l = GmailApp.getUserLabelByName(name);
    if (l) l.deleteLabel();
  });
}

function sync() {
  const res = UrlFetchApp.fetch(SERVER + "/api/threads", { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return; // server waking up; next minute
  const threads = JSON.parse(res.getContentText());

  // Nothing changed since the last run → don't touch Gmail at all.
  const props = PropertiesService.getUserProperties();
  const state = JSON.stringify(threads.map((t) => [t.key, t.status]));
  if (props.getProperty("state") === state) return;

  const sent = getLabel(LABEL_SENT);
  const read = getLabel(LABEL_READ);
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
  let complete = true;

  threads.forEach((t) => {
    if (t.activity < cutoff) return;
    const thread = findThread(t);
    if (!thread) {
      complete = false; // e.g. still in the Undo-send delay; retry next minute
      return;
    }
    const names = thread.getLabels().map((l) => l.getName());
    const want = t.status === "sent" ? sent : read;
    const drop = t.status === "sent" ? read : sent;
    if (names.indexOf(drop.getName()) !== -1) thread.removeLabel(drop);
    if (names.indexOf(want.getName()) === -1) thread.addLabel(want);
  });

  if (complete) props.setProperty("state", state);
}

function getLabel(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// The Gmail conversation for a tracked thread: by Gmail's thread id when the
// extension learned it, otherwise by searching Sent for subject + recipient.
function findThread(t) {
  let id = "";
  const m = /^thread-f:(\d+)$/.exec(t.key);
  if (m) id = BigInt(m[1]).toString(16); // "thread-f:<decimal>" → API thread id (hex)
  else if (/^[0-9a-f]{12,}$/i.test(t.key)) id = t.key;
  if (id) {
    try {
      const th = GmailApp.getThreadById(id);
      if (th) return th;
    } catch (e) {}
  }
  const to = (t.to.match(/[^\s,<>]+@[^\s,<>]+/) || [])[0];
  const q = 'in:sent subject:"' + t.subject.replace(/"/g, " ") + '"' + (to ? " to:" + to : "");
  const found = GmailApp.search(q, 0, 1);
  return found.length ? found[0] : null;
}
