(function () {
  "use strict";

  // Async scripts can still read document.currentScript reliably as long as
  // it's read synchronously during the script's own top-level execution
  // (the standard technique real embeddable widgets use) — the src-pattern
  // fallback covers any environment where that's ever untrue.
  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (/\/widget\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
    }
    return null;
  }

  var script = currentScript();
  if (!script) return;

  var shop = script.getAttribute("data-shop");
  if (!shop) {
    console.error("Job It Ready widget: missing data-shop attribute.");
    return;
  }

  var position = script.getAttribute("data-position") || "bottom-right";
  var isRight = position.indexOf("left") === -1;

  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    return;
  }

  // Shadow DOM keeps the host page's CSS from bleeding into the button/panel
  // chrome — the actual quote flow itself is in an iframe, which is fully
  // isolated regardless, so this only matters for the button + frame itself.
  var host = document.createElement("div");
  host.id = "jir-widget-host";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  var side = isRight ? "right" : "left";
  var style = document.createElement("style");
  style.textContent =
    ":host { all: initial; }" +
    ".jir-btn { position: fixed; bottom: 20px; " + side + ": 20px; z-index: 2147483000; width: 56px; height: 56px; border-radius: 999px; background: #B4531F; color: #fff; border: none; box-shadow: 0 6px 20px rgba(0,0,0,0.25); cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }" +
    ".jir-btn:hover { filter: brightness(1.05); }" +
    ".jir-panel { position: fixed; bottom: 90px; " + side + ": 20px; z-index: 2147483000; width: 380px; max-width: calc(100vw - 32px); height: 600px; max-height: calc(100vh - 120px); border-radius: 12px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,0.3); background: #fff; display: none; }" +
    ".jir-panel.jir-open { display: block; }" +
    ".jir-panel iframe { width: 100%; height: 100%; border: none; display: block; }" +
    ".jir-close { position: absolute; top: 8px; right: 8px; z-index: 1; width: 28px; height: 28px; border-radius: 999px; border: none; background: rgba(0,0,0,0.08); cursor: pointer; font-size: 15px; line-height: 1; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }" +
    "@media (max-width: 480px) { .jir-panel { width: calc(100vw - 24px); height: calc(100vh - 100px); bottom: 84px; right: 12px; left: 12px; } }";
  root.appendChild(style);

  var button = document.createElement("button");
  button.className = "jir-btn";
  button.type = "button";
  button.setAttribute("aria-label", "Get an estimate");
  button.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
  root.appendChild(button);

  var panel = document.createElement("div");
  panel.className = "jir-panel";
  root.appendChild(panel);

  var closeBtn = document.createElement("button");
  closeBtn.className = "jir-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  panel.appendChild(closeBtn);

  var iframe = null;

  function open() {
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.src = origin + "/widget/" + encodeURIComponent(shop);
      iframe.title = "Get an estimate";
      panel.appendChild(iframe);
    }
    panel.classList.add("jir-open");
  }

  function close() {
    panel.classList.remove("jir-open");
  }

  button.addEventListener("click", function () {
    if (panel.classList.contains("jir-open")) close();
    else open();
  });
  closeBtn.addEventListener("click", close);
})();
