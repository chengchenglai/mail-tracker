// Mail Tracker — injects an invisible tracking pixel into Gmail compose windows
// and registers the mail when it is sent. Works regardless of Gmail UI language
// (detects the Send button by its stable CSS class, not by localized text).

const SERVER = "https://mailtrack-server.onrender.com"; // deployed server URL

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Compose body: language-independent (g_editable is set by Gmail, not localized)
function getBody(scope) {
  return scope.querySelector('div[g_editable="true"][role="textbox"]');
}
function getSubject(dialog) {
  // New mail: the compose has its own subject input.
  const s = dialog.querySelector('input[name="subjectbox"]');
  if (s && s.value) return s.value;
  // Reply / inline reply: no subject box — use the open conversation's
  // thread subject header (h2.hP is Gmail's subject title, language-neutral).
  const h = document.querySelector("h2.hP");
  if (h && h.textContent.trim()) return "Re: " + h.textContent.trim();
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

// Inject the invisible pixel into a compose body (once per body).
function injectPixel(body) {
  if (!body || body.dataset.mtInjected) return body?.dataset.mtInjected;
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

function register(id, dialog) {
  if (!id) return;
  const payload = {
    id,
    subject: getSubject(dialog),
    to: getRecipients(dialog),
  };
  console.log("[MailTracker] registering", payload);
  fetch(`${SERVER}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(() => console.log("[MailTracker] registered OK", id))
    .catch((e) => console.warn("[MailTracker] register failed", e));
}

// Find the compose container that holds a given element.
function composeOf(el) {
  return el.closest('div[role="dialog"]') || el.closest(".nH.Hd") || el.closest(".iN") || document;
}

// Watch for compose windows and inject the pixel as they appear.
const observer = new MutationObserver(() => {
  document.querySelectorAll('div[g_editable="true"][role="textbox"]').forEach(injectPixel);
});
observer.observe(document.body, { childList: true, subtree: true });
// also run once on load for already-open composes
document.querySelectorAll('div[g_editable="true"][role="textbox"]').forEach(injectPixel);

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
    if (!isSendButton(btn)) return;
    const dialog = composeOf(btn);
    const body = getBody(dialog);
    const id = body ? injectPixel(body) || body.dataset.mtInjected : null;
    register(id, dialog);
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      const dialog = composeOf(e.target);
      const body = getBody(dialog);
      const id = body ? injectPixel(body) || body.dataset.mtInjected : null;
      register(id, dialog);
    }
  },
  true
);

console.log("[MailTracker] active →", SERVER);
