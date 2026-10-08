/* Fam Bash Pickems live board (no dependencies). Contract: /workspace/pickems/HOOKS.md
   While the tab is visible: fetch /board/current.json right away and every 60 s (cache-busted), and right away when
   the tab becomes visible again; then patch the page in place through data hooks. Missing hooks are no-ops.
   Web entries: each poll also reads the public /api/entries?week=N (Turso, Monday picks + tiebreakers already
   omitted until Sunday is final) and merges any entry the board doesn't have yet as an unpaid row (cloned from an
   build_site <template data-row> or an existing row, marked data-web="1"), scored with the board's results by the same rules as pickems_status, so a new
   entry shows within a poll instead of waiting for the box sync. Once the sync puts it on the board, the row is
   adopted in place (no reload); if the entry disappears from the server, the row is removed.
   A new week, or a real board player added/removed, triggers ONE full reload instead (never a loop).
   Optional config before this script: window.PICKEMS_LIVE = {url: "/board/current.json", interval: 60000,
   entries: "/api/entries" (false = no merge)}. Fires document "pickems:board" (detail = board incl. merged players,
   which carry web: true). Hook names map to status.text keys; "leader-short" reads text.leader_short. */
(function () {
  "use strict";
  var cfg = window.PICKEMS_LIVE || {};
  var URL_ = cfg.url || "/board/current.json", EVERY = cfg.interval || 60000, RELOAD_KEY = "pickems-live-reloaded";
  var ENTRIES = cfg.entries === false ? null : (cfg.entries || "/api/entries");
  var timer = null, busy = false, first = null, lastEntries = null;
  var TEXT_KEY = {"leader-short": "leader_short"};                    // data-hook name -> status.text key (else same name)
  var LOCK = {cls: "pick-hidden", text: "\uD83D\uDD12"};

  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function setText(el, t) { if (t !== undefined && t !== null && el.textContent !== String(t)) el.textContent = String(t); }
  function setAttr(el, k, v) { if (el.getAttribute(k) !== String(v)) el.setAttribute(k, String(v)); }
  function pageWeek() { var el = document.querySelector("[data-week]"); return el ? el.getAttribute("data-week") : null; }
  function pagePlayers() {   // real (server-rendered or adopted) rows only; merged web rows don't count
    var seen = {}; all("tr[data-player]:not([data-web])").forEach(function (tr) { seen[tr.getAttribute("data-player")] = 1; });
    return Object.keys(seen).sort();
  }

  // ---- same rules as pickems_status.py ----
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function stripTag(t) { return String(t == null ? "" : t).replace(/^[() ]+|[() ]+$/g, ""); }
  function playerKey(name, tag) { return slug(name + " " + stripTag(tag)) || "player"; }
  function nameKey(n) { return String(n == null ? "" : n).trim().toLowerCase().replace(/\s+/g, " "); }
  function leaderShort(labels) {
    if (!labels.length) return "\u2014";
    if (labels.length === 1) return labels[0];
    var extra = labels.length - 2;
    return "Tied: " + labels.slice(0, 2).join(", ") + (extra ? " +" + extra + " more" : "");
  }

  /** board + public web entries -> board with every not-yet-synced web entry merged in (pure; exported for tests). */
  function merge(b, entries) {
    if (!b || !b.players || !b.games || !entries || !entries.length) return b;
    var st = b.status || {}, revealed = !!st.sunday_final, abbr = b.abbr || {};
    var ab = function (t) { return abbr[t] || String(t).slice(0, 3).toUpperCase(); };
    var keys = {}, names = {};
    b.players.forEach(function (p) { keys[p.key] = 1; names[nameKey(p.name)] = 1; });
    var added = [];
    entries.forEach(function (en) {
      if (!en || !en.name) return;
      var k = playerKey(en.name, en.tag);
      if (keys[k] || names[nameKey(en.name)]) return;                  // already on the board (synced) -> board wins
      keys[k] = 1; names[nameKey(en.name)] = 1;
      var picks = {}, score = 0;
      b.games.forEach(function (g) {
        var pick = (en.picks || {})[g.matchup];
        if (g.hidden) { picks[g.key] = LOCK; return; }                 // never show a hidden pick, whatever the API sent
        var text = pick ? ab(pick) : "\u2014", cls = "pick-pending";
        if (g.status === "final" && g.winner) { cls = pick === g.winner ? "pick-win" : "pick-loss"; if (pick === g.winner) score++; }
        picks[g.key] = {cls: cls, text: text};
      });
      var tb = revealed && en.tiebreaker != null && en.tiebreaker !== "" ? Number(en.tiebreaker) : null;
      picks.tb = revealed ? {cls: "pick-tb", text: tb != null && isFinite(tb) ? String(Math.trunc(tb)) : "\u2014"} : LOCK;
      var tag = stripTag(en.tag), p = {key: k, name: String(en.name), tag: tag, display: tag ? en.name + " (" + tag + ")" : String(en.name),
               rank: 0, score: score, leader: false, paid: false, picks: picks, web: true};
      if (revealed) { p.tiebreaker = tb != null && isFinite(tb) ? Math.trunc(tb) : null;
        if (p.tiebreaker != null && b.mnf_total != null) p.tiebreaker_off = Math.abs(p.tiebreaker - Number(b.mnf_total)); }
      added.push(p);
    });
    if (!added.length) return b;
    var out = JSON.parse(JSON.stringify(b)), ps = out.players.concat(added);
    // split: a game not final/hidden where players disagree (no pick counts as its own value), like build_site
    out.games.forEach(function (g) {
      if (g.hidden || (g.status === "final" && g.winner)) return;
      var seen = {}, n = 0;
      ps.forEach(function (p) { var c = p.picks[g.key]; if (c && !seen[c.text]) { seen[c.text] = 1; n++; } });
      ps.forEach(function (p) { var c = p.picks[g.key]; if (c && (c.cls === "pick-split" || c.cls === "pick-pending")) p.picks[g.key] = {cls: n > 1 ? "pick-split" : "pick-pending", text: c.text}; });
    });
    // order: correct desc, tiebreaker distance (once revealed), then entry order (board order, web entries appended)
    var off = function (p) { return p.tiebreaker_off != null ? p.tiebreaker_off : null; };
    ps = ps.map(function (p, i) { return {p: p, i: i}; }).sort(function (x, y) {
      return (y.p.score - x.p.score) || ((off(x.p) == null ? 999 : off(x.p)) - (off(y.p) == null ? 999 : off(y.p))) || (x.i - y.i);
    }).map(function (x) { return x.p; });
    var rank = 0, prev = null, lead = ps.length ? ps[0].score : 0;
    ps.forEach(function (p, i) { var kk = p.score + "|" + off(p); if (kk !== prev) { rank = i + 1; prev = kk; } p.rank = rank; p.leader = p.score === lead && lead > 0; });
    out.players = ps;
    var s = out.status, fee = Number(out.fee != null ? out.fee : 10), n = ps.length;
    s.entries = n; s.pot = n * fee;
    var leaders = [];
    if (s.games_final > 0 && ps.length) { var top = ps[0].score + "|" + off(ps[0]); leaders = ps.filter(function (p) { return p.score + "|" + off(p) === top; }); }
    s.leaders = leaders.map(function (p) { return {key: p.key, name: p.name, display: p.display, score: p.score}; });
    s.leaders_count = leaders.length;
    s.text = s.text || {};
    s.text.pot = "$" + s.pot; s.text.entries = n + " " + (n === 1 ? "entry" : "entries");
    s.text.leader = leaders.length ? leaders.map(function (p) { return p.name; }).join(" & ") + " \u00B7 " + leaders[0].score : "\u2014";
    s.text.leader_short = leaderShort(leaders.map(function (p) { return p.name; }));
    out.web_merged = added.length;
    return out;
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

  // ---- merged web rows: cloned from an existing row of the same table, text only (never innerHTML) ----
  function fillRow(tr, p, fee) {
    tr.setAttribute("data-web", "1"); tr.classList.remove("lead");
    [tr].concat(all("[data-player]", tr)).forEach(function (el) { el.setAttribute("data-player", p.key); });
    var who = tr.querySelector("td.who");
    if (who) {
      var nm = who.querySelector(".nm"), tg;
      if (nm) {
        nm.textContent = p.name; tg = who.querySelector(".tag");
        if (p.tag) { if (!tg) { tg = document.createElement("span"); tg.className = "tag"; nm.parentNode.insertBefore(tg, nm.nextSibling); } tg.textContent = p.tag; }
        else if (tg) tg.parentNode.removeChild(tg);
      } else {
        while (who.firstChild) who.removeChild(who.firstChild);
        who.appendChild(document.createTextNode(p.name));
        if (p.tag) { who.appendChild(document.createTextNode(" ")); tg = document.createElement("span"); tg.className = "tag"; tg.textContent = p.tag; who.appendChild(tg); }
      }
    }
    var rk = tr.querySelector(".rkt"); if (rk) rk.textContent = String(p.rank);
    var tbc = tr.querySelector("td.tbc"); if (tbc) tbc.textContent = p.tiebreaker != null ? String(p.tiebreaker) : "\u2014";
    var pd = tr.querySelector(".pdc");
    if (pd) { while (pd.firstChild) pd.removeChild(pd.firstChild); var o = document.createElement("span"); o.className = "owe"; o.textContent = "owes $" + fee; pd.appendChild(o); }
  }
  function syncWebRows(real, aug) {
    var want = {};
    (aug.players || []).forEach(function (p) { if (p.web) want[p.key] = p; });
    var realKeys = {}; (real.players || []).forEach(function (p) { realKeys[p.key] = 1; });
    all("tr[data-player][data-web]").forEach(function (tr) {             // entry gone from the server -> drop the row
      var k = tr.getAttribute("data-player"); if (!want[k] && !realKeys[k] && tr.parentNode) tr.parentNode.removeChild(tr);
    });
    var fee = Number(aug.fee != null ? aug.fee : 10);
    all("tbody").forEach(function (tb) {
      var rows = all("tr[data-player]", tb), te = tb.querySelector("template[data-row]");
      // build_site's inert <template data-row> (works for an empty table); older pages: clone a real row
      var tpl = (te && te.content && te.content.querySelector("tr")) || all("tr[data-player]:not([data-web])", tb)[0] || rows[0];
      if (!tpl) return;                                                  // nothing to clone from in this table
      var have = {}; rows.forEach(function (r) { have[r.getAttribute("data-player")] = 1; });
      Object.keys(want).forEach(function (k) { if (!have[k]) { var tr = tpl.cloneNode(true); fillRow(tr, want[k], fee); tb.appendChild(tr); } });
    });
  }

  function apply(real, entries) {
    if (!real || !real.status) return;
    var realKeys = {}; (real.players || []).forEach(function (p) { realKeys[p.key] = 1; });
    all("tr[data-player][data-web]").forEach(function (tr) { if (realKeys[tr.getAttribute("data-player")]) tr.removeAttribute("data-web"); }); // synced: adopt in place
    if (needsReload(real)) return;
    var b = merge(real, entries === undefined ? lastEntries : entries);
    syncWebRows(real, b);
    var st = b.status, text = st.text || {}, byKey = {};
    (b.players || []).forEach(function (p) { byKey[p.key] = p; });
    var card = document.getElementById("status-card");
    if (card && st.state) setAttr(card, "data-state", st.state);
    all("[data-hook]").forEach(function (el) {
      var h = el.getAttribute("data-hook");
      if (h === "score" && el.hasAttribute("data-player")) {
        var p = byKey[el.getAttribute("data-player")]; if (p) setText(el, p.score);
      } else if (Object.prototype.hasOwnProperty.call(text, TEXT_KEY[h] || h)) {
        setText(el, text[TEXT_KEY[h] || h]);
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

  function getJSON(u) {
    return fetch(u + (u.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now(), {cache: "no-store"})
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function refresh() {
    if (busy || document.visibilityState === "hidden") return;
    busy = true;
    getJSON(URL_).then(function (b) {
      if (!b) return;
      if (!ENTRIES) return apply(b, null);
      return getJSON(ENTRIES + "?week=" + encodeURIComponent(b.week)).then(function (r) {
        if (r && r.ok && Array.isArray(r.entries) && String(r.week) === String(b.week)) lastEntries = r.entries;  // keep the last good list on errors
        apply(b, lastEntries);
      });
    }).catch(function () { /* offline / 404: try again next tick */ }).then(function () { busy = false; });
  }
  function start() { stop(); timer = setInterval(refresh, EVERY); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { refresh(); start(); } else { stop(); }
  });
  if (document.visibilityState !== "hidden") { refresh(); start(); }
  window.PickemsLive = {refresh: refresh, apply: apply, merge: merge, playerKey: playerKey};
})();
