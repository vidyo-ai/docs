// Mintlify includes every .js in the repo on every page. Links to mailto:help@quso.ai (navbar
// "Contact Us", sidebar anchor, article footers) open the PostHog Support widget the way the app does
// (helpers/support.ts): prime the stored panel state to "open", show(), and trust the widget's
// $conversations_widget_loaded / _state_changed events (show() renders asynchronously). The click is
// queued until PostHog/the widget is ready; the mailto opens only if the panel has not opened in 3 s.
(function () {
  var MAILTO = "mailto:help@quso.ai";
  var TIMEOUT = 3000;
  var TICK = 100;
  var attempt = false;

  function capture(ph, event, props) {
    try {
      if (ph && ph.capture) ph.capture(event, props);
    } catch (e) {}
  }
  function keyOf(ph) {
    return ph && ph.config && ph.config.token ? "ph_conv_" + ph.config.token : null;
  }
  function read(ph) {
    var k = keyOf(ph);
    if (!k) throw new Error("no token");
    return JSON.parse(localStorage.getItem(k) || "{}");
  }
  function write(ph, state) {
    var st = read(ph);
    st.widgetState = state;
    localStorage.setItem(keyOf(ph), JSON.stringify(st));
  }

  function open() {
    var ticks = 0, started = false, retried = false, done = false, off = null;
    function reopen(conv) {
      if (conv.isVisible && conv.isVisible() && conv.hide) conv.hide();
      conv.show();
    }
    function finish(channel, reason) {
      if (done) return;
      done = true;
      attempt = false;
      var ph = window.posthog;
      try {
        if (off) off();
      } catch (e) {}
      if (channel === "email") {
        try {
          if (started) {
            write(ph, "closed");
            // a late render must not open chat after the mailto: unmount it when it finally loads
            var conv0 = ph.conversations;
            var unhide = ph.on("eventCaptured", function (ev) {
              if (!ev || (ev.event !== "$conversations_widget_loaded" && ev.event !== "$conversations_widget_state_changed")) return;
              try {
                unhide();
                if (conv0.isVisible && conv0.isVisible()) conv0.hide();
              } catch (e) {}
            });
          }
        } catch (e) {}
        capture(ph, "support_widget_failed", { entry_point: "help_center_link", reason: reason });
        window.location.href = MAILTO;
      }
      capture(ph, "support_opened", { entry_point: "help_center_link", channel: channel });
    }
    function tick() {
      if (done) return;
      ticks += 1;
      var ph = window.posthog;
      var conv = ph && ph.conversations;
      try {
        if (conv && typeof conv.show === "function" && (!conv.isAvailable || conv.isAvailable()) && !started) {
          var stored = null;
          try {
            stored = read(ph).widgetState || null;
            if (stored === "open" && conv.isVisible && conv.isVisible()) return finish("widget"); // already open
            write(ph, "open");
          } catch (e) {
            return finish("email", "storage"); // show() would restore a closed panel
          }
          started = true;
          try {
            off = ph.on("eventCaptured", function (ev) {
              if (done || !ev) return;
              if (ev.event === "$conversations_widget_loaded") {
                if (ev.properties && ev.properties.initialState === "open") return finish("widget");
                if (!retried) {
                  retried = true; // init was already pending with the pre-primed state: open once more
                  try {
                    reopen(conv);
                  } catch (e) {
                    finish("email", "error");
                  }
                } else finish("email", "closed");
              } else if (ev.event === "$conversations_widget_state_changed" && ev.properties && ev.properties.state === "open") {
                finish("widget");
              }
            });
          } catch (e) {}
          reopen(conv);
        }
      } catch (e) {
        return finish("email", "error");
      }
      if (ticks * TICK >= TIMEOUT) {
        // Opted-out capture suppresses the widget events: if the launcher is mounted, keep the widget.
        try {
          if (started && ph.has_opted_out_capturing && ph.has_opted_out_capturing() && conv.isVisible()) return finish("widget");
        } catch (e) {}
        return finish("email", started ? "timeout" : "unavailable");
      }
      setTimeout(tick, TICK);
    }
    tick();
  }

  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[href^="mailto:help@quso.ai"]');
    if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button > 0) return;
    ev.preventDefault();
    if (attempt) return; // repeated click while opening: no second open, no remount
    attempt = true;
    open();
  });
})();
