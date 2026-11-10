// Mail Tracker — injects an invisible tracking pixel into Gmail compose windows
// and registers the mail when it is sent. Works regardless of Gmail UI language
// (detects the Send button by its stable CSS class, not by localized text).
//
// It also watches the conversation you have open, for two reasons:
//  - your own Gmail renders the tracked pixels too; reporting that lets the
//    server discard those hits instead of counting them as the recipient's
//  - it can see whether the other side has answered in the thread

const SERVER = "https://mailtrack-server.onrender.com"; // deployed server URL
const EDITABLE = 'div[g_editable="true"][role="textbox"]';
const QUOTE = ".gmail_quote, blockquote, .gmail_extra";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Tracking id of one of OUR pixels, or null. Matches both the raw URL and
// Gmail's image-proxy form (…googleusercontent.com/…#<original url>).
const PIXEL_RE = new RegExp(
  SERVER.replace(/^https?:\/\//, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/t/([a-z0-9]+)\\.gif",
  "i"
);
function pixelId(img) {
  const m = PIXEL_RE.exec(img.getAttribute("src") || "");
  return m ? m[1] : null;
}

function post(path, payload) {
  return fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// ---------- compose ----------

// Compose body: language-independent (g_editable is set by Gmail, not localized)
function getBody(scope) {
  return scope.querySelector(EDITABLE);
}
// The conversation currently open behind/around the compose, if any.
function openThread() {
  const h = document.querySelector("h2.hP");
  if (!h || !h.textContent.trim()) return null;
  return {
    el: h,
    subject: h.textContent.trim(),
    gthread: h.getAttribute("data-thread-perm-id") || h.getAttribute("data-legacy-thread-id") || "",
  };
}
function getSubject(dialog) {
  // New mail: the compose has its own subject input.
  const s = dialog.querySelector('input[name="subjectbox"]');
  if (s && s.value) return s.value;
  // Reply / inline reply: no subject box — use the open conversation's
  // thread subject header (h2.hP is Gmail's subject title, language-neutral).
  const t = openThread();
  if (t) return "Re: " + t.subject;
  return "(no subject)";
}
function getRecipients(dialog) {
  const chips = dialog.querySelectorAll("[data-hovercard-id], span[email], div[email]");
  const set = new Set();
  chips.forEach((c) => {
    const e = c.getAttribute("data-hovercard-id") || c.getAttribute("email");
    if (e && e.includes("@")) set.add(e);
  });
  return [...set].join(", ") || "(unknown)";
}

// Thread key = subject with Re:/Fwd: prefixes stripped, so every message in a
// back-and-forth groups under one conversation in the dashboard.
function normalizeSubject(s) {
  return (
    (s || "")
      .replace(/^((re|fwd|fw|回覆|回复|轉寄|转寄|回復)\s*[:：]?\s*)+/i, "")
      .trim() || "(no subject)"
  );
}

// Gmail thread id for a compose — only when the compose really belongs to the
// open conversation: an inline reply, or a popped-out reply whose subject still
// matches. A brand-new mail written while some thread is open gets none.
function gthreadFor(dialog, subject) {
  const t = openThread();
  if (!t || !t.gthread) return "";
  const inline = !dialog.matches || !dialog.matches('div[role="dialog"]');
  return inline || normalizeSubject(subject) === normalizeSubject(t.subject) ? t.gthread : "";
}

// First line of what YOU typed in this reply (quoted history removed), so each
// message in a long thread is identifiable at a glance.
function getSnippet(body) {
  if (!body) return "";
  const clone = body.cloneNode(true);
  clone.querySelectorAll(QUOTE + ", .gmail_signature").forEach((n) => n.remove());
  const t = (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
  return t.slice(0, 80);
}

// Make sure a compose body carries exactly ONE pixel of ours, outside the
// quoted history, and return its id.
//  - pixels inside the quote belong to earlier mails of the thread; left in,
//    opening this mail would fire them and mark those old mails as "opened"
//  - a reopened draft (or "Undo send") already has its pixel: reuse it rather
//    than stacking a second one
function ensurePixel(body) {
  if (!body) return null;
  let own = null;
  body.querySelectorAll("img").forEach((img) => {
    const id = pixelId(img);
    if (!id) return;
    if (img.closest(QUOTE) || own) img.remove();
    else own = { id, img };
  });
  if (own) {
    if (own.id !== body.dataset.mtInjected) body.dataset.mtInjected = own.id;
    return own.id;
  }
  const id = uid();
  body.dataset.mtInjected = id;
  const img = document.createElement("img");
  img.src = `${SERVER}/t/${id}.gif`;
  img.width = 1;
  img.height = 1;
  img.alt = "";
  img.style.cssText = "width:1px;height:1px;border:0;opacity:0;display:block";
  body.appendChild(img);
  console.log("[MailTracker] pixel injected", id);
  return id;
}

function register(dialog) {
  const body = getBody(dialog);
  const id = ensurePixel(body);
  if (!id) return;
  const subject = getSubject(dialog);
  const payload = {
    id,
    subject,
    to: getRecipients(dialog),
    thread: normalizeSubject(subject),
    gthread: gthreadFor(dialog, subject),
    snippet: getSnippet(body),
  };
  console.log("[MailTracker] registering", payload);
  post("/api/register", payload)
    .then(() => {
      console.log("[MailTracker] registered OK", id);
      loadThreads(); // show the ✓ for the mail just sent
    })
    .catch((e) => console.warn("[MailTracker] register failed", e));
}

// Find the compose container that holds a given element.
function composeOf(el) {
  return el.closest('div[role="dialog"]') || el.closest(".nH.Hd") || el.closest(".iN") || document;
}

// Register on SEND — detected language-independently:
//  - the blue Send button carries the stable class "aoO"
//  - Ctrl/Cmd+Enter keyboard shortcut
const SEND_RE = /傳送|送信|Send|보내기|Enviar|Envoyer|Senden/i;
function isSendButton(el) {
  if (!el) return false;
  if (el.classList && el.classList.contains("aoO")) return true; // stable class
  const tip = (el.getAttribute("data-tooltip") || el.getAttribute("aria-label") || "").trim();
  return SEND_RE.test(tip); // multilingual fallback by tooltip text
}

document.addEventListener(
  "click",
  (e) => {
    const btn = e.target.closest("div[role='button'], .aoO");
    if (isSendButton(btn)) register(composeOf(btn));
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && e.target.closest) {
      const dialog = composeOf(e.target);
      if (dialog !== document && getBody(dialog)) register(dialog);
    }
  },
  true
);

// ---------- watching the open conversation ----------

function myEmail() {
  // Gmail's tab title is "<subject> - <my address> - Gmail" in every language.
  const m = document.title.match(/[^\s<>()"']+@[^\s<>()"']+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : "";
}

const reportedImgs = new WeakSet(); // pixel <img> elements already reported
let lastReplyKey = ""; // thread + newest sender we last told the server about

function scanThread() {
  const t = openThread();
  if (!t) {
    lastReplyKey = "";
    return;
  }
  const main = t.el.closest('div[role="main"]') || document;
  const me = myEmail();
  const senderOf = (msg) => {
    const s = msg && msg.querySelector(".gD[email]");
    return s ? s.getAttribute("email").toLowerCase() : "";
  };

  // Tracked pixels Gmail is rendering right now (compose windows excluded).
  const ids = new Set();
  const quoted = [];
  let fresh = false;
  main.querySelectorAll("img").forEach((img) => {
    const id = pixelId(img);
    if (!id || img.closest(EDITABLE)) return;
    ids.add(id);
    if (!reportedImgs.has(img)) {
      reportedImgs.add(img);
      fresh = true;
    }
    // My pixel inside a message someone else wrote = they replied on top of it.
    const from = senderOf(img.closest(".adn"));
    if (me && from && from !== me) quoted.push({ id, from });
  });

  // Gmail always expands the newest message, so the last expanded one tells us
  // who spoke last.
  const msgs = main.querySelectorAll(".adn");
  const lastFrom = senderOf(msgs[msgs.length - 1]);
  const replyKey = `${t.gthread}|${t.subject}|${lastFrom}|${quoted.length}`;
  const replyNews = !!me && !!lastFrom && replyKey !== lastReplyKey;

  if (!fresh && !replyNews) return;
  lastReplyKey = replyKey;
  post("/api/view", {
    ids: fresh ? [...ids] : [],
    gthread: t.gthread,
    thread: normalizeSubject(t.subject),
    me,
    lastFrom,
    quoted,
  }).catch((e) => console.warn("[MailTracker] view report failed", e));
}

// ---------- double-check marks in Gmail ----------
// ✓✓ next to a tracked conversation, in the mail list and beside the subject of
// the open conversation:  green + grey = sent, not opened yet
//                         green + green = the other side has opened it
const GREEN = "#1e8e3e";
const GREY = "#c4c7c5";
let threads = []; // latest /api/threads

async function loadThreads() {
  if (document.hidden) return;
  try {
    threads = await (await fetch(SERVER + "/api/threads")).json();
    renderTicks();
  } catch {}
}

// Conversation for a Gmail thread id (several spellings may be offered), or —
// only for conversations whose thread id is not known yet — by subject.
function findThread(gids, subject) {
  const ids = gids.filter(Boolean).map((g) => g.replace(/^#/, ""));
  const byId = threads.find((t) => ids.includes(t.key));
  if (byId) return byId;
  const s = normalizeSubject(subject);
  return threads.find((t) => t.key.includes("|") && t.subject === s) || null;
}

function tickInfo(t) {
  const time = (ms) => new Date(ms).toLocaleString();
  if (t.status === "replied") return { read: true, tip: "對方已回覆" };
  if (t.status === "read")
    return { read: true, tip: `對方已讀 · 最後開啟 ${time(t.lastOpenAt)}（共 ${t.openCount} 次）` };
  return { read: false, tip: `已寄出、尚未開啟 · ${time(t.sentAt)}` };
}

// Built node by node: Gmail enforces Trusted Types, so innerHTML is off limits.
function makeTicks() {
  const NS = "http://www.w3.org/2000/svg";
  const wrap = document.createElement("span");
  wrap.className = "mt-ticks";
  wrap.style.cssText = "display:inline-flex;vertical-align:middle;margin:0 6px;flex:none;cursor:default";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 16");
  svg.setAttribute("width", "21");
  svg.setAttribute("height", "14");
  for (const d of ["M1.5 8.5l4 4 8-9", "M9.5 8.5l4 4 8-9"]) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke-width", "2.4");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
  }
  wrap.appendChild(svg);
  return wrap;
}

// Put (or update, or remove) the marks for conversation `t` inside `host`.
// Touches the DOM only when something actually changed, so it cannot feed the
// MutationObserver in a loop.
function setTicks(host, t, place) {
  let el = host.querySelector(":scope > .mt-ticks");
  if (!t) {
    if (el) el.remove();
    return;
  }
  const { read, tip } = tickInfo(t);
  const state = (read ? "read|" : "sent|") + tip;
  if (el && el.dataset.state === state) return;
  if (!el) {
    el = makeTicks();
    place(el);
  }
  el.dataset.state = state;
  el.title = tip;
  const [a, b] = el.querySelectorAll("path");
  a.setAttribute("stroke", GREEN);
  b.setAttribute("stroke", read ? GREEN : GREY);
}

function renderTicks() {
  // open conversation: right after the subject title
  const t = openThread();
  if (t) {
    const box = t.el.parentElement;
    const h = t.el;
    setTicks(
      box,
      findThread([h.getAttribute("data-thread-perm-id"), h.getAttribute("data-legacy-thread-id")], t.subject),
      (el) => h.after(el)
    );
  }
  // mail list rows: in front of the subject
  document.querySelectorAll("tr.zA").forEach((row) => {
    const subj = row.querySelector(".bog");
    if (!subj || !subj.parentElement) return;
    const idEl = row.querySelector("[data-thread-id], [data-legacy-thread-id]");
    const gids = idEl
      ? [idEl.getAttribute("data-thread-id"), idEl.getAttribute("data-legacy-thread-id")]
      : [];
    setTicks(subj.parentElement, findThread(gids, subj.textContent), (el) => subj.before(el));
  });
}

setInterval(loadThreads, 20000);
document.addEventListener("visibilitychange", loadThreads);
loadThreads();

// ---------- one observer drives everything ----------
let scanTimer = null;
function onDomChange() {
  document.querySelectorAll(EDITABLE).forEach(ensurePixel);
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanThread();
    renderTicks();
  }, 400);
}
new MutationObserver(onDomChange).observe(document.body, { childList: true, subtree: true });
onDomChange(); // already-open composes / conversation

console.log("[MailTracker] active →", SERVER);
