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
      var td = document.createElement("td");
      td.colSpan = 5;
      td.style.textAlign = "center";
      td.style.padding = "18px";
      td.style.color = "#d6c4a8";
      td.textContent = "No entries yet this week";
      empty.appendChild(td);
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
      var sameRank = players.filter(function (x) { return x.rank === p.rank; }).length;
      var rankTxt = (sameRank > 1 ? "T" : "") + (p.rank || "");

      var tdRk = document.createElement("td");
      tdRk.className = "rk";
      var sp = document.createElement("span");
      sp.className = "rkt";
      sp.textContent = rankTxt;
      tdRk.appendChild(sp);
      tr.appendChild(tdRk);

      var tdWho = document.createElement("td");
      tdWho.className = "who";
      tdWho.title = p.display || p.name || "";
      tdWho.appendChild(document.createTextNode(p.name || ""));
      if (p.tag) {
        var tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = p.tag;
        tdWho.appendChild(document.createTextNode(" "));
        tdWho.appendChild(tag);
      }
      tr.appendChild(tdWho);

      var tdSc = document.createElement("td");
      tdSc.className = "num sc";
      var bEl = document.createElement("b");
      bEl.setAttribute("data-hook", "score");
      bEl.setAttribute("data-player", p.key || "");
      bEl.textContent = p.score || 0;
      tdSc.appendChild(bEl);
      var of = document.createElement("span");
      of.className = "of";
      of.appendChild(document.createTextNode("/"));
      var gf = document.createElement("span");
      gf.setAttribute("data-hook", "games-final");
      gf.textContent = gamesFinal;
      of.appendChild(gf);
      tdSc.appendChild(of);
      tr.appendChild(tdSc);

      var tdTb = document.createElement("td");
      tdTb.className = "num tbc";
      tdTb.textContent = p.tiebreaker != null ? p.tiebreaker : "\u2014";
      tr.appendChild(tdTb);

      var tdPaid = document.createElement("td");
      tdPaid.className = "pdc";
      tdPaid.setAttribute("data-fee", fee);
      var badge = document.createElement("span");
      if (p.void) { badge.className = "void"; badge.textContent = "VOID"; }
      else if (p.paid) { badge.className = "paid"; badge.textContent = "\u2713 paid"; }
      else { badge.className = "owe"; badge.textContent = "owes $" + fee; }
      tdPaid.appendChild(badge);
      tr.appendChild(tdPaid);

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
      th.appendChild(document.createTextNode(g.matchup || g.key));
      var sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = (g.status === "final" && g.score) ? (g.score + " F") : (g.when || "");
      th.appendChild(sub);
      thead.appendChild(th);
    });
    var tbTh = document.createElement("th"); tbTh.textContent = "TB"; thead.appendChild(tbTh);
    var totTh = document.createElement("th"); totTh.className = "b tot"; totTh.textContent = "Tot"; thead.appendChild(totTh);

    clearRows(tbody);
    var players = b.players || [];
    if (!players.length) {
      var empty = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = (b.games || []).length + 3;
      td.style.textAlign = "center";
      td.style.padding = "18px";
      td.style.color = "#d6c4a8";
      td.textContent = "No picks yet";
      empty.appendChild(td);
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
      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name || "";
      who.appendChild(nm);
      if (p.tag) {
        var tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = p.tag;
        who.appendChild(tag);
      }
      var scb = document.createElement("span");
      scb.className = "scb";
      scb.textContent = p.score || 0;
      who.appendChild(scb);
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
      var sp = document.createElement("span");
      sp.setAttribute("data-hook", "score");
      sp.textContent = p.score || 0;
      tot.appendChild(sp);
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
    // ---- week labels (replace any hard-coded Week N) ----
    var wk = b.week;
    if (wk) {
      document.title = "Fam Bash Pickems · Week " + wk;
      var meta = $(".meta");
      if (meta) {
        var first = meta.childNodes[0];
        if (first && first.nodeType === 3) first.textContent = "Week " + wk + " · " + (b.year || "");
      }
      var eyebrow = $(".eyebrow span:last-child");
      if (eyebrow) {
        var gf = (st.games_final != null ? st.games_final : 0);
        var gt = (st.games_total != null ? st.games_total : 0);
        eyebrow.innerHTML = "Week " + wk + " · <span data-hook=\"games-final\">" + gf + "</span> of " + gt + " final";
      }
      var prev = $(".prevwk");
      if (prev && wk > 1) {
        prev.href = "/week" + (wk - 1);
        prev.innerHTML = "🏁 Week " + (wk - 1) + " final: see the board →";
      }
      var hype = $(".hype");
      if (hype) hype.innerHTML = "👀 Your name could be next. Week " + wk + " champ gets <b>$" + (st.payout || 0) + "</b>. Who\'s taking it? 💰";
    }
    // ---- Hall of Champions: ensure Week 8 winner is present ----
    var hall = $(".hall table");
    if (hall && !hall.querySelector("[data-wk=\"8\"]")) {
      var tbody = hall.querySelector("tbody") || hall;
      var row = document.createElement("tr");
      row.setAttribute("data-wk", "8");
      row.innerHTML = "<td class=\"wk\">Wk 8</td><td class=\"who\" title=\"Mario (Niños Bonitos)\"><span class=\"hrow\"><span class=\"cup\" aria-hidden=\"true\">🏆</span><b class=\"nm\">Mario</b></span><span class=\"tag\">Niños Bonitos</span></td><td class=\"num\">12/14<span class=\"hnote\">won TB (41 vs 28)</span></td><td class=\"num cash\">$100<span class=\"dim\">10 entries</span></td>";
      var firstData = hall.querySelector("tr:not(:first-child)");
      if (firstData && firstData.parentNode) firstData.parentNode.insertBefore(row, firstData);
      else hall.appendChild(row);
      var tot = hall.querySelector("tr.tot .cash");
      if (tot) tot.textContent = "$830";
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
