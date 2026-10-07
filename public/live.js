/* Fam Bash Pickems live board (no dependencies). Contract: /workspace/pickems/HOOKS.md
   While the tab is visible: re-fetch /board/current.json every 60 s (cache-busted) and right away when the tab becomes
   visible again, then patch the page in place through data hooks. Missing hooks are no-ops. A new week, or a player
   added/removed, triggers ONE full reload instead (never a loop). Optional config before this script:
   window.PICKEMS_LIVE = {url: "/board/current.json", interval: 60000}. Fires document "pickems:board" (detail = board). */
(function () {
  "use strict";
  var cfg = window.PICKEMS_LIVE || {};
  var URL_ = cfg.url || "/board/current.json", EVERY = cfg.interval || 60000, RELOAD_KEY = "pickems-live-reloaded";
  var timer = null, busy = false, first = null;

  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function setText(el, t) { if (t !== undefined && t !== null && el.textContent !== String(t)) el.textContent = String(t); }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v)); }
  function pageWeek() { var el = document.querySelector("[data-week]"); return el ? el.getAttribute("data-week") : null; }
  function pagePlayers() {
    var seen = {}; all("tr[data-player]").forEach(function (tr) { seen[tr.getAttribute("data-player")] = 1; });
    return Object.keys(seen).sort();
  }

  function needsReload(b) {
    var week = String(b.week), keys = (b.players || []).map(function (p) { return p.key; }).sort();
    var pw = pageWeek(), pp = pagePlayers();
    if (!first) first = {week: week, keys: keys};                     // baseline when the page carries no hooks
    var changed = (pw !== null ? pw !== week : first.week !== week) ||
                  (pp.length ? pp.join("|") !== keys.join("|") : first.keys.join("|") !== keys.join("|"));
    if (!changed) return false;
    var sig = week + ":" + keys.join("|");
    try { if (sessionStorage.getItem(RELOAD_KEY) === sig) return false; sessionStorage.setItem(RELOAD_KEY, sig); } catch (e) { return false; }
    location.reload();
    return true;
  }

  function apply(b) {
    if (!b || !b.status || needsReload(b)) return;
    var st = b.status, text = st.text || {}, byKey = {};
    (b.players || []).forEach(function (p) { byKey[p.key] = p; });
    var card = document.getElementById("status-card");
    if (card && st.state) setAttr(card, "data-state", st.state);
    all("[data-hook]").forEach(function (el) {
      var h = el.getAttribute("data-hook");
      if (h === "score" && el.hasAttribute("data-player")) {
        var p = byKey[el.getAttribute("data-player")]; if (p) setText(el, p.score);
      } else if (Object.prototype.hasOwnProperty.call(text, h)) {
        setText(el, text[h]);
      }
    });
    all("tr[data-player]").forEach(function (tr) {
      var p = byKey[tr.getAttribute("data-player")]; if (!p) return;
      setAttr(tr, "data-rank", p.rank); setAttr(tr, "data-leader", p.leader ? "true" : "false");
    });
    all("td[data-player][data-game]").forEach(function (td) {
      var p = byKey[td.getAttribute("data-player")], c = p && p.picks && p.picks[td.getAttribute("data-game")];
      if (!c) return;
      if (!td.classList.contains(c.cls)) {
        Array.prototype.slice.call(td.classList).forEach(function (k) { if (k.indexOf("pick-") === 0) td.classList.remove(k); });
        td.classList.add(c.cls);
      }
      setText(td, c.text);
    });
    try { document.dispatchEvent(new CustomEvent("pickems:board", {detail: b})); } catch (e) { /* old browsers */ }
  }

  function refresh() {
    if (busy || document.visibilityState === "hidden") return;
    busy = true;
    fetch(URL_ + (URL_.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), {cache: "no-store"})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply)
      .catch(function () { /* offline / 404: try again next tick */ })
      .then(function () { busy = false; });
  }
  function start() { stop(); timer = setInterval(refresh, EVERY); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { refresh(); start(); } else { stop(); }
  });
  if (document.visibilityState !== "hidden") start();
  window.PickemsLive = {refresh: refresh, apply: apply};
})();
