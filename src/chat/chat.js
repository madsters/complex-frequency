// chat.js — a floating "ask a question" widget for the Complex Frequency story.
//
// HOW THIS WORKS (for someone learning JS):
//   * This file is an ES module. The host adds <script type="module" src=...>
//     for it in index.html. Because it's a module, the code below runs ONCE
//     automatically when the browser imports it — that's why we call init()
//     at the bottom. No app.js changes are needed; it "self-initializes".
//   * It builds a small launcher button (bottom-left) and a chat panel using
//     plain DOM calls (document.createElement). Styles live in components.css.
//   * When the user sends a message we POST it to /api/chat on the SAME origin
//     (the Python proxy serves both the site and the API), so there are no CORS
//     issues and the secret API key stays on the server.
//
// The proxy may respond with:
//   200 {reply}            -> show the assistant's text
//   503 {error}            -> chat is "offline" (no API key configured)
//   429 {error}            -> rate limited; we surface the "try again" message
//   4xx/5xx {error}        -> some other problem; show the error text
//
// Everything is commented generously on purpose.

// We keep a short rolling history so the model has a little context. Each entry
// is {role: "user"|"assistant", content: string}. We only keep the last few.
const history = [];
const MAX_HISTORY = 8; // entries kept client-side (server also clips its own)

// References to elements we need to touch later. Filled in by init().
let panelEl = null;     // the whole chat panel container
let listEl = null;      // the scrollable message list
let inputEl = null;     // the textarea the user types into
let sendBtn = null;     // the send button
let launcherEl = null;  // the floating button that opens/closes the panel

let isOpen = false;     // is the panel visible?
let isAwaiting = false; // are we waiting on a server reply? (disables send)

/**
 * Create an element with optional class and text. Tiny helper to keep the
 * DOM-building code below readable.
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Append a message bubble to the list and scroll to the bottom.
 * `role` is "user", "assistant", or "system" (system = status/error notes).
 * Returns the bubble element so callers can update it (e.g. swap "thinking…").
 */
function addBubble(role, text) {
  const bubble = el("div", `cf-chat-msg cf-chat-${role}`, text);
  listEl.appendChild(bubble);
  // Scroll the newest message into view.
  listEl.scrollTop = listEl.scrollHeight;
  return bubble;
}

/** Show or hide the panel, and move focus to the input when opening. */
function setOpen(open) {
  isOpen = open;
  panelEl.classList.toggle("cf-chat-open", open);
  launcherEl.setAttribute("aria-expanded", String(open));
  if (open) {
    // Defer focus until the panel is visible.
    setTimeout(() => inputEl && inputEl.focus(), 50);
  }
}

/** Enable/disable the send button + input while a request is in flight. */
function setAwaiting(awaiting) {
  isAwaiting = awaiting;
  sendBtn.disabled = awaiting;
  inputEl.disabled = awaiting;
  sendBtn.textContent = awaiting ? "…" : "Send";
}

/**
 * Send the current input to the proxy and render the result.
 * This is an async function so we can `await` the network call.
 */
async function send() {
  if (isAwaiting) return; // guard against double-sends
  const text = inputEl.value.trim();
  if (!text) return;

  // Show the user's message, clear the input, and record it in history.
  addBubble("user", text);
  inputEl.value = "";
  history.push({ role: "user", content: text });

  // Show a temporary "thinking" bubble we'll replace with the real reply.
  setAwaiting(true);
  const thinking = addBubble("assistant", "Thinking…");
  thinking.classList.add("cf-chat-thinking");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Send the message plus a clipped history (server clips again too).
      body: JSON.stringify({
        message: text,
        history: history.slice(-MAX_HISTORY),
      }),
    });

    // Try to parse JSON either way — both replies and errors are JSON.
    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = {};
    }

    // Remove the "Thinking…" placeholder before showing the outcome.
    thinking.remove();

    if (res.ok && data.reply) {
      // Happy path: show the assistant reply and remember it.
      addBubble("assistant", data.reply);
      history.push({ role: "assistant", content: data.reply });
      // Keep history from growing without bound.
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    } else if (res.status === 503) {
      // No API key on the server -> chat is offline.
      addBubble(
        "system",
        data.error || "Chat is offline right now.",
      );
    } else if (res.status === 429) {
      // Rate limited -> surface the "try again in N s" hint from the server.
      addBubble("system", data.error || "Too many requests — please slow down.");
    } else {
      // Any other error (400/413/502/…): show the server's message if present.
      addBubble("system", data.error || `Something went wrong (HTTP ${res.status}).`);
    }
  } catch (err) {
    // Network failure (server down, offline, etc.).
    thinking.remove();
    addBubble("system", "Could not reach the chat server. Is it running?");
  } finally {
    setAwaiting(false);
    inputEl.focus();
  }
}

/** Build the whole widget and wire up events. Runs once on import. */
function init() {
  // Guard: don't inject twice if this module is somehow imported again.
  if (document.getElementById("cf-chat-launcher")) return;

  // --- launcher button (bottom-left) ---
  launcherEl = el("button", "cf-chat-launcher");
  launcherEl.id = "cf-chat-launcher";
  launcherEl.type = "button";
  launcherEl.setAttribute("aria-label", "Ask a question about this story");
  launcherEl.setAttribute("aria-expanded", "false");
  launcherEl.innerHTML = '<span class="cf-chat-launcher-icon">?</span><span class="cf-chat-launcher-label">Ask</span>';

  // --- panel ---
  panelEl = el("section", "cf-chat-panel");
  panelEl.setAttribute("aria-label", "Story chat");

  // Header with a title and a close button.
  const header = el("header", "cf-chat-header");
  header.appendChild(el("span", "cf-chat-title", "Ask about this story"));
  const closeBtn = el("button", "cf-chat-close", "×");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  header.appendChild(closeBtn);

  // Message list (scrollable).
  listEl = el("div", "cf-chat-list");

  // A friendly first message so the box isn't empty.
  const intro = el(
    "div",
    "cf-chat-msg cf-chat-system",
    "Hi! Ask me about complex frequency, the Frenet frame, or this story — e.g. \"What is the radial frequency ρ?\"",
  );
  listEl.appendChild(intro);

  // Input row: a textarea + send button.
  const inputRow = el("form", "cf-chat-input-row");
  inputEl = el("textarea", "cf-chat-input");
  inputEl.rows = 1;
  inputEl.placeholder = "Ask a question…";
  inputEl.setAttribute("aria-label", "Your question");
  inputEl.maxLength = 1500; // mirror the server's MAX_MESSAGE_CHARS guard
  sendBtn = el("button", "cf-chat-send", "Send");
  sendBtn.type = "submit";
  inputRow.appendChild(inputEl);
  inputRow.appendChild(sendBtn);

  // Assemble the panel.
  panelEl.appendChild(header);
  panelEl.appendChild(listEl);
  panelEl.appendChild(inputRow);

  // Add both to the page.
  document.body.appendChild(launcherEl);
  document.body.appendChild(panelEl);

  // --- events ---
  launcherEl.addEventListener("click", () => setOpen(!isOpen));
  closeBtn.addEventListener("click", () => setOpen(false));

  // Submit the form on Send click OR Enter (without Shift).
  inputRow.addEventListener("submit", (e) => {
    e.preventDefault(); // don't reload the page
    send();
  });
  inputEl.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Close on Escape when the panel is focused/open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) setOpen(false);
  });
}

// Self-initialize. If the DOM isn't ready yet, wait for it; otherwise run now.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
