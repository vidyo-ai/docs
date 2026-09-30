// Mintlify includes every .js in the repo on every page. Links to mailto:help@quso.ai (navbar
// "Contact Us", sidebar anchor, article footers) open the PostHog Support widget when it is loaded
// (integrations.posthog in docs.json); otherwise the mailto opens as before, so the link never dies.
(function () {
  var MAILTO = "mailto:help@quso.ai";
  function capture(ph, event, props) {
    try {
      if (ph && ph.capture) ph.capture(event, props);
    } catch (e) {}
  }
  document.addEventListener("click", function (ev) {
    var a = ev.target && ev.target.closest && ev.target.closest('a[href^="mailto:help@quso.ai"]');
    if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button > 0) return;
    var ph = window.posthog;
    var opening = false;
    try {
      var conv = ph && ph.conversations;
      if (conv && typeof conv.show === "function" && (!conv.isAvailable || conv.isAvailable())) {
        var primed = false;
        var token = ph.config && ph.config.token;
        if (token) {
          try {
            var key = "ph_conv_" + token;
            var st = JSON.parse(localStorage.getItem(key) || "{}");
            st.widgetState = "open";
            localStorage.setItem(key, JSON.stringify(st));
            primed = true;
          } catch (e) {}
        }
        // Storage blocked: show() would restore a closed panel, so keep the mailto.
        if (primed) {
          if (conv.isVisible && conv.isVisible() && conv.hide) conv.hide();
          conv.show();
          opening = true;
          // show() renders asynchronously: check the panel really appeared, else open the mailto.
          setTimeout(function () {
            var visible = true;
            try {
              visible = !conv.isVisible || conv.isVisible();
            } catch (e) {}
            if (!visible) {
              capture(ph, "support_widget_failed", { entry_point: "help_center_link" });
              window.location.href = MAILTO;
            }
          }, 1500);
        }
      }
    } catch (e) {
      opening = false;
    }
    capture(ph, "support_opened", { entry_point: "help_center_link", channel: opening ? "widget" : "email" });
    if (opening) ev.preventDefault();
  });
})();
