// Mintlify includes every .js in the repo on every page. Links to mailto:help@quso.ai (navbar
// "Contact Us", sidebar anchor, article footers) open the PostHog Support widget when it is loaded
// (integrations.posthog in docs.json); otherwise the mailto opens as before, so the link never dies.
(function () {
  document.addEventListener("click", function (ev) {
    try {
      var a = ev.target && ev.target.closest && ev.target.closest('a[href^="mailto:help@quso.ai"]');
      if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button > 0) return;
      var ph = window.posthog;
      var conv = ph && ph.conversations;
      if (!conv || typeof conv.show !== "function" || (conv.isAvailable && !conv.isAvailable())) return;
      var token = ph.config && ph.config.token;
      var primed = false;
      if (token) {
        try {
          var key = "ph_conv_" + token;
          var st = JSON.parse(localStorage.getItem(key) || "{}");
          st.widgetState = "open";
          localStorage.setItem(key, JSON.stringify(st));
          primed = true;
        } catch (e) {}
      }
      if (conv.isVisible && conv.isVisible() && conv.hide) conv.hide();
      conv.show();
      // Opened only if the panel is really visible; otherwise (domain not allowed, init pending,
      // storage blocked) the mailto proceeds.
      var opened = primed && conv.isVisible && conv.isVisible();
      if (ph.capture) ph.capture("support_opened", { entry_point: "help_center_link", channel: opened ? "widget" : "email" });
      if (opened) ev.preventDefault();
    } catch (e) {}
  });
})();
