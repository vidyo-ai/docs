// Port of quso-landing src/lib/support.js (PR #91 @ 4f111f6): one implementation, tested in both repos
// (scripts/support-widget.test.mjs here). Only the adapter differs: Mintlify includes every .js as a
// plain script (IIFE, no import/export), there is no posthogFailed boot flag (a PostHog that never
// appears falls back to the mailto at OPEN_TIMEOUT_MS), and links are matched by their mailto href.
// The body below is the landing module verbatim (minus "export"), unindented to keep it diffable.
(function (root) {
// Support entry points (owner decision 2026-09-30: all support runs through PostHog Support).
// Every "Contact / Support / Talk to us" link is a real `mailto:help@quso.ai` anchor tagged
// data-support="<entry_point>". A click opens the PostHog Support widget the way the app does
// (apps/vidyo-ui helpers/support.ts): prime the stored panel state to "open", then show(), and trust the
// widget's own `$conversations_widget_loaded` / `$conversations_widget_state_changed` events rather than
// isVisible(), because show() renders asynchronously. Those events are the only open signal, so a visitor
// who opted out of capture (no events) gets the mailto straight away. The click is never dead: while the SDK or widget
// is still initialising the open is queued, and the mailto fallback only fires if the panel has not
// opened within OPEN_TIMEOUT_MS. Plain JS with an injected window so scripts can test it in node.

const SUPPORT_EMAIL = "help@quso.ai";
const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;
const OPEN_TIMEOUT_MS = 3000;
const TICK_MS = 100;
const CLEANUP_MS = 30000;

// Cancels the previous attempt's late-render cleanup, so it cannot hide a later attempt's panel.
function cancelCleanup(win) {
  const cancel = win.__supportCleanup;
  win.__supportCleanup = null;
  try {
    if (cancel) cancel();
  } catch (e) {}
}

function safeCapture(ph, event, props) {
  try {
    if (ph && typeof ph.capture === "function") ph.capture(event, props);
  } catch (e) {}
}

const storageKey = (ph) => (ph && ph.config && ph.config.token ? `ph_conv_${ph.config.token}` : null);

// The widget persists its panel state under ph_conv_<token> on every open/close. Returns "open",
// "closed" or null (unset); throws when storage is blocked.
function readState(win, ph) {
  const key = storageKey(ph);
  if (!key) throw new Error("no token");
  const stored = JSON.parse(win.localStorage.getItem(key) || "{}");
  return stored.widgetState || null;
}

function writeState(win, ph, state) {
  const key = storageKey(ph);
  if (!key) throw new Error("no token");
  const stored = JSON.parse(win.localStorage.getItem(key) || "{}");
  win.localStorage.setItem(key, JSON.stringify({ ...stored, widgetState: state }));
}

// Starts (at most one at a time) an attempt to open the panel. Returns "widget" when the caller must
// suppress the mailto because the attempt owns the click, or "email" when the mailto should proceed now.
function openSupport(win, entryPoint) {
  if (win.__supportAttempt) return "widget"; // repeated click while opening: no second open, no remount
  if (win.posthogFailed) return "email"; // SDK blocked or failed to start: nothing will ever load
  cancelCleanup(win);
  let ticks = 0;
  let started = false;
  let retried = false;
  let done = false;
  let off = null;

  const attempt = (win.__supportAttempt = {});

  const finish = (channel, reason) => {
    if (done) return;
    done = true;
    win.__supportAttempt = null;
    const ph = win.posthog;
    try {
      if (off) off();
    } catch (e) {}
    if (channel === "email") {
      // A late render must not open chat after the mailto has already launched: keep a one-shot
      // listener that unmounts the widget when it finally loads or opens.
      try {
        if (started) {
          writeState(win, ph, "closed");
          const conv = ph.conversations;
          const unhide = ph.on("eventCaptured", (ev) => {
            if (!ev || (ev.event !== "$conversations_widget_loaded" && ev.event !== "$conversations_widget_state_changed")) return;
            cancelCleanup(win);
            try {
              if (conv.isVisible && conv.isVisible()) conv.hide();
            } catch (e) {}
          });
          win.__supportCleanup = unhide;
          win.setTimeout(() => {
            if (win.__supportCleanup === unhide) cancelCleanup(win);
          }, CLEANUP_MS);
        }
      } catch (e) {}
      safeCapture(ph, "support_widget_failed", { entry_point: entryPoint, reason });
      try {
        win.location.href = SUPPORT_MAILTO;
      } catch (e) {}
    }
    safeCapture(ph, "support_opened", { entry_point: entryPoint, channel });
  };

  const reopen = (ph, conv) => {
    if (conv.isVisible && conv.isVisible() && typeof conv.hide === "function") conv.hide();
    conv.show();
  };

  const tick = () => {
    if (done) return;
    ticks += 1;
    const ph = win.posthog;
    const conv = ph && ph.conversations;
    if (!ph && win.posthogFailed) return finish("email", "sdk");
    try {
      // Opted out of capture: the widget events never fire, so an open could not be confirmed.
      if (!started && ph && typeof ph.has_opted_out_capturing === "function" && ph.has_opted_out_capturing()) {
        return finish("email", "opted_out");
      }
      if (conv && typeof conv.show === "function" && (typeof conv.isAvailable !== "function" || conv.isAvailable())) {
        if (!started) {
          let stored = null;
          try {
            stored = readState(win, ph);
          } catch (e) {
            return finish("email", "storage"); // show() would restore a closed panel
          }
          if (stored === "open" && conv.isVisible && conv.isVisible()) {
            attempt.opened = true;
            return finish("widget"); // already open: leave it (and any unsent text) alone
          }
          try {
            writeState(win, ph, "open");
          } catch (e) {
            return finish("email", "storage");
          }
          started = true;
          try {
            off = ph.on("eventCaptured", (ev) => {
              if (done || !ev) return;
              if (ev.event === "$conversations_widget_loaded") {
                if (ev.properties && ev.properties.initialState === "open") return finish("widget");
                // Loaded with the state read before we primed it (init was already pending): open once more.
                if (!retried) {
                  retried = true;
                  try {
                    reopen(ph, conv);
                  } catch (e) {
                    finish("email", "error");
                  }
                } else finish("email", "closed");
              } else if (
                ev.event === "$conversations_widget_state_changed" &&
                ev.properties &&
                ev.properties.state === "open"
              ) {
                finish("widget");
              }
            });
          } catch (e) {
            // No event API: the deadline below decides.
          }
          reopen(ph, conv);
        }
      }
    } catch (e) {
      return finish("email", "error");
    }
    if (ticks * TICK_MS >= OPEN_TIMEOUT_MS) {
      return finish("email", started ? "timeout" : "unavailable");
    }
    win.setTimeout(tick, TICK_MS);
  };

  tick();
  return "widget";
}

// Docs adapter: one delegated listener for every mailto:help@quso.ai link (navbar, sidebar, articles).
function wireSupportLinks(win) {
  win.document.addEventListener("click", (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest(`a[href^="${SUPPORT_MAILTO}"]`) : null;
    if (!el) return;
    // Let modified clicks (new tab, etc.) behave like a normal mailto link.
    if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button > 0) return;
    if (openSupport(win, "help_center_link") === "widget") ev.preventDefault();
  });
}

const api = { SUPPORT_EMAIL, SUPPORT_MAILTO, OPEN_TIMEOUT_MS, openSupport, wireSupportLinks };
if (typeof module === "object" && module.exports) module.exports = api;
else if (root && root.document) wireSupportLinks(root);
})(typeof window !== "undefined" ? window : undefined);
