/* Fam Bash Pickems live board.
   Fetches GET /api/games?board=1 (Turso + ESPN) and fully rebuilds the standings + picks
   tables from it. When the week has no entries the standings are empty. */
(function () {
  "use strict";
  var cfg = window.PICKEMS_LIVE || {};
  var URL_ = cfg.url || "/api/games?board=1";
  var EVERY = cfg.interval || 60000;
  var timer = null, busy = false;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return {"&":"&","<":"<",">":">","\"":""","'":"&#39;"}[c]; }); }

  function setHook(name, text) {
    $$('[data-hook="' + name + '"]').forEach(function (el) { el.textContent = text == null ? "" : String(text); });
  }

  function clearRows(tbody) {
    if (!tbody) return;
    var tmpl = tbody.querySelector("template");
    var nodes = Array.prototype.slice.call(tbody.childNodes);
    nodes.forEach(function (n) { if (n !== tmpl && n.nodeType === 1) tbody.removeChild(n); });
  }

  function rebuildStandings(b) {
    var card = $("#standings");
    if (!card) return;
    var tbody = card.querySelector("tbody");
    if (!tbody) return;
    clearRows(tbody);
    var players = b.players || [];
    if (!players.length) {
      var empty = document.createElement("tr");
      empty.innerHTML = '<td colspan="5" style="text-align:center;padding:18px;color:#d6c4a8">No entries yet this week</td>';
      tbody.appendChild(empty);
      return;
    }
    var fee = Number(b.fee || 10);
    var gamesFinal = (b.status && b.status.games_final) || 0;
    players.forEach(function (p) {
      var tr = document.createElement("tr");
      if (p.leader) tr.classList.add("lead");
      if (p.void) tr.classList.add("void");
      if (!p.paid && !p.void) tr.classList.add("unpaid");
      tr.setAttribute("data-player", p.key || "");
      tr.setAttribute("data-rank", p.rank || "");
      tr.setAttribute("data-leader", p.leader ? "true" : "false");
      var rankTxt = (p.rank && players.filter(function (x) { return x.rank === p.rank; }).length > 1 ? "T" : "") + (p.rank || "");
      var paidHtml = p.void ? '<span class="void">VOID</span>' : (p.paid ? '<span class="paid">\u2713 paid</span>' : '<span class="owe">owes $' + fee + '</span>');
      var tb = p.tiebreaker != null ? p.tiebreaker : "\u2014";
      tr.innerHTML =
        '<td class="rk"><span class="rkt">' + esc(rankTxt) + '</span></td>' +
        '<td class="who" title="' + esc(p.display || p.name) + '">' + esc(p.name) + (p.tag ? ' <span class="tag">' + esc(p.tag) + '</span>' : '') + '</td>' +
        '<td class="num sc"><b data-hook="score" data-player="' + esc(p.key) + '">' + (p.score || 0) + '</b><span class="of">/<span data-hook="games-final">' + gamesFinal + '</span></span></td>' +
        '<td class="num tbc">' + esc(tb) + '</td>' +
        '<td class="pdc" data-fee="' + fee + '">' + paidHtml + '</td>';
      tbody.appendChild(tr);
    });
  }

  function rebuildPicks(b) {
    var sec = $("#sec-picks");
    if (!sec) return;
    var table = sec.querySelector("table");
    if (!table) return;
    var thead = table.querySelector("thead tr");
    var tbody = table.querySelector("tbody");
    if (!thead || !tbody) return;
    var first = thead.querySelector("th:not([data-game])");
    while (thead.lastChild && thead.lastChild !== first) thead.removeChild(thead.lastChild);
    (b.games || []).forEach(function (g) {
      var th = document.createElement("th");
      th.setAttribute("data-game", g.key);
      th.setAttribute("data-when", g.when || "");
      th.className = "g" + (g.is_monday ? " mon" : "");
      th.innerHTML = (g.matchup || g.key) + '<div class="sub">' + (g.status === "final" && g.score ? esc(g.score) + " F" : (g.when || "")) + "</div>";
      thead.appendChild(th);
    });
    var tbTh = document.createElement("th"); tbTh.textContent = "TB"; thead.appendChild(tbTh);
    var totTh = document.createElement("th"); totTh.className = "b tot"; totTh.textContent = "Tot"; thead.appendChild(totTh);

    clearRows(tbody);
    var players = b.players || [];
    if (!players.length) {
      var empty = document.createElement("tr");
      empty.innerHTML = '<td colspan="' + ((b.games || []).length + 3) + '" style="text-align:center;padding:18px;color:#d6c4a8">No picks yet</td>';
      tbody.appendChild(empty);
      return;
    }
    players.forEach(function (p) {
      var tr = document.createElement("tr");
      if (p.leader) tr.classList.add("lead");
      tr.setAttribute("data-player", p.key || "");
      var who = document.createElement("td");
      who.className = "who";
      who.title = p.display || p.name || "";
      who.innerHTML = '<div class="nmrow"><span class="nmw"><span class="nm">' + esc(p.name) + '</span>' + (p.tag ? '<span class="tag">' + esc(p.tag) + '</span>' : '') + '</span><span class="scb">' + (p.score || 0) + '</span></div>';
      tr.appendChild(who);
      (b.games || []).forEach(function (g) {
        var td = document.createElement("td");
        var pk = (p.picks || {})[g.key] || {};
        td.className = pk.cls || "pick-pending";
        td.setAttribute("data-player", p.key || "");
        td.setAttribute("data-game", g.key);
        td.textContent = pk.text || "";
        tr.appendChild(td);
      });
      var tb = document.createElement("td");
      tb.className = "num pick-tb";
      tb.textContent = p.tiebreaker != null ? p.tiebreaker : "\u2014";
      tr.appendChild(tb);
      var tot = document.createElement("td");
      tot.className = "num b tot";
      tot.innerHTML = '<span data-hook="score">' + (p.score || 0) + '</span>';
      tr.appendChild(tot);
      tbody.appendChild(tr);
    });
  }

  function apply(b) {
    if (!b || !b.status) return;
    var st = b.status, text = st.text || {};
    var card = $("#status-card");
    if (card) {
      if (st.state) card.setAttribute("data-state", st.state);
      if (st.week) card.setAttribute("data-week", st.week);
      card.setAttribute("data-submit", st.submit_open ? "open" : "closed");
      card.setAttribute("data-picks", st.picks_locked ? "locked" : "open");
    }
    setHook("updated", text.updated || "");
    setHook("games-final", st.games_final);
    setHook("payout", text.payout || ("$" + (st.payout || 0)));
    setHook("entries", text.entries || ((st.entries || 0) + " entries"));
    setHook("leader-short", text.leader_short || "\u2014");
    setHook("leader", text.leader || "\u2014");
    setHook("lock", text.lock || "");
    setHook("pot", text.pot || "");
    var meta = $(".meta");
    if (meta && b.week) {
      var first = meta.childNodes[0];
      if (first && first.nodeType === 3) first.textContent = "Week " + b.week + " \u00b7 " + (b.year || "");
    }
    rebuildStandings(b);
    rebuildPicks(b);
    try { document.dispatchEvent(new CustomEvent("pickems:board", {detail: b})); } catch (e) {}
  }

  function refresh() {
    if (busy) return;
    busy = true;
    var u = URL_ + (URL_.indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
    fetch(u, {cache: "no-store"})
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
