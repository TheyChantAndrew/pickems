/* Fam Bash Pickems live board (no dependencies).
   Dynamic board: GET /api/games?board=1 (Turso + ESPN). No bot publish required.
*/
(function () {
  "use strict";
  var cfg = window.PICKEMS_LIVE || {};
  var URL_ = cfg.url || "/api/games?board=1", EVERY = cfg.interval || 60000, RELOAD_KEY = "pickems-live-reloaded";
  var ENTRIES = cfg.entries === false ? null : (cfg.entries || "/api/entries");
  var ESPN = cfg.espn === false ? null : (cfg.espn || "/api/games?live=1");
  var lastEspn = null, ESPN_MAX_AGE = 180000;
  var timer = null, busy = false, first = null, lastEntries = null, lastPaidLive = false, lastTombs = [], lastReal = null, closeTimer = null;
  var TEXT_KEY = {"leader-short": "leader_short"};
  var LOCK = {cls: "pick-hidden", text: "\uD83D\uDD12"};

  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function setText(el, t) { if (t !== undefined && t !== null && el.textContent !== String(t)) el.textContent = String(t); }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v)); }

  function needsReload() { return false; } // dynamic board: never full-reload

  function apply(real) {
    if (!real || !real.status) return;
    lastReal = real;
    var st = real.status, text = st.text || {};
    var card = document.getElementById("status-card");
    if (card && st.state) setAttr(card, "data-state", st.state);
    if (card && st.week) setAttr(card, "data-week", st.week);
    all("[data-hook]").forEach(function (el) {
      var h = el.getAttribute("data-hook");
      if (Object.prototype.hasOwnProperty.call(text, TEXT_KEY[h] || h)) setText(el, text[TEXT_KEY[h] || h]);
    });
    try { document.dispatchEvent(new CustomEvent("pickems:board", {detail: real})); } catch (e) {}
  }

  function refresh() {
    if (busy) return;
    busy = true;
    fetch(URL_ + (URL_.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), {cache: "no-store"})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) { if (b && b.status) apply(b); })
      .catch(function () {})
      .then(function () { busy = false; });
  }

  function start() { if (timer) clearInterval(timer); timer = setInterval(refresh, EVERY); }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { refresh(); start(); }
  });
  if (document.visibilityState !== "hidden") { refresh(); start(); }
  window.PickemsLive = {refresh: refresh, apply: apply};
})();
