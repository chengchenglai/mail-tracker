// Mail Tracker — injects an invisible tracking pixel into Gmail compose windows
// and hooks the Send button so every outgoing mail is registered + tracked.

const SERVER = "http://localhost:3000"; // change to your deployed server URL

function uid() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

// Find the contenteditable body of a given compose dialog.
function getBody(dialog) {
  return dialog.querySelector('div[aria-label="Message Body"], div[g_editable="true"][role="textbox"]');
}

function getSubject(dialog) {
  const s = dialog.querySelector('input[name="subjectbox"]');
  return s ? s.value : "(no subject)";
}

function getRecipients(dialog) {
  // Gmail stores recipients as chips with email in various attrs
  const chips = dialog.querySelectorAll(
    'div[role="listbox"] [data-hovercard-id], span[email], div[email]'
  );
  const set = new Set();
  chips.forEach((c) => {
    const e = c.getAttribute("data-hovercard-id") || c.getAttribute("email");
    if (e && e.includes("@")) set.add(e);
  });
  return [...set].join(", ") || "(unknown)";
}

// Already-injected guard per compose body.
function injectPixel(dialog) {
  const body = getBody(dialog);
  if (!body || body.dataset.mtInjected) return;

  const id = uid();
  body.dataset.mtInjected = id;

  // The invisible pixel. Zero visual footprint, no caption, no branding.
  const img = document.createElement("img");
  img.src = `${SERVER}/t/${id}.gif`;
  img.width = 1;
  img.height = 1;
  img.alt = "";
  img.style.cssText = "width:1px;height:1px;border:0;opacity:0;display:block";
  // append at the very end of the body
  body.appendChild(img);

  // Register when the user actually sends.
  hookSend(dialog, id, body);
}

function hookSend(dialog, id, body) {
  const sendBtn = dialog.querySelector('div[role="button"][data-tooltip*="Send"], div[role="button"][aria-label*="Send"]');
  const register = () => {
    // re-read subject/recipients at send time (they may have changed)
    const payload = {
      id,
      subject: getSubject(dialog),
      to: getRecipients(dialog),
    };
    fetch(`${SERVER}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  };

  if (sendBtn && !sendBtn.dataset.mtHooked) {
    sendBtn.dataset.mtHooked = "1";
    sendBtn.addEventListener("click", register, true);
  }
  // Ctrl/Cmd+Enter shortcut send
  body.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") register();
    },
    true
  );
}

// Watch for compose dialogs appearing.
const observer = new MutationObserver(() => {
  document
    .querySelectorAll('div[role="dialog"], div.nH.Hd')
    .forEach((d) => {
      if (getBody(d)) injectPixel(d);
    });
  // inline reply boxes
  document.querySelectorAll('div[g_editable="true"][role="textbox"]').forEach((b) => {
    const dialog = b.closest('div[role="dialog"]') || b.closest("table") || b.parentElement;
    if (dialog) injectPixel(dialog);
  });
});

observer.observe(document.body, { childList: true, subtree: true });
console.log("[MailTracker] active");
