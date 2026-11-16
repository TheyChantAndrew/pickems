/* Fam Bash Pickems live board.
   Fetches GET /api/games?board=1 (Turso + ESPN) and fully rebuilds the standings + picks
   tables from it. When the week has no entries the standings are empty. */
(function () {
  "use strict";
  var cfg = window.PICKEMS_LIVE || {};
  var URL_ = cfg.url || "/api/games?board=1";
  var EVERY = cfg.interval || 60000;
  var timer = null, busy = false;
  // Weeks with no champion. Week 9: the site was down, so the only saved row is a void test entry.
  var BYE_WEEKS = {9: "BYE WEEK — the whole league was on bye"};
  function weekFromLocation() {
    var m = /[?&]week=(\d+)/.exec(location.search);
    var n = m ? Number(m[1]) : 0;
    return n >= 1 && n <= 30 ? n : 0;
  }
  var viewing = weekFromLocation();
  var applied = null;
  var pushNext = false;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function ensureCta() {
    var card = $("#status-card");
    if (!card) return;
    if (card.querySelector(".cta")) return;
    var banner = card.querySelector(".lockbanner");
    var cta = document.createElement("a");
    cta.className = "cta";
    cta.href = "/submit";
    cta.innerHTML = "Make your picks<span>$10 entry · free to edit until lock</span>";
    if (banner && banner.nextSibling) {
      banner.parentNode.insertBefore(cta, banner.nextSibling);
    } else if (banner) {
      banner.parentNode.appendChild(cta);
    } else {
      card.appendChild(cta);
    }
  }

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
      var hype = $(".hype");
      if (hype) {
        if (BYE_WEEKS[wk]) hype.textContent = BYE_WEEKS[wk] + ". No champion and no payout.";
        else hype.innerHTML = "👀 Your name could be next. Week " + wk + " champ gets <b>$" + (st.payout || 0) + "</b>. Who\'s taking it? 💰";
      }
      if (b.current_week && wk !== b.current_week && card) card.setAttribute("data-submit", "closed");
    }
    syncNav(b);
    ensureCta();
    rebuildStandings(b);
    rebuildPicks(b);
    try { ensureHall(b); } catch (e) { /* a hall glitch must not freeze the board */ }
    try { document.dispatchEvent(new CustomEvent("pickems:board", {detail: b})); } catch (e) {}
  }

  function ensureHall() {
    var hall = $(".hall table");
    if (!hall) return;
    if (!hall.querySelector("[data-wk=\"8\"]")) {
      var row = document.createElement("tr");
      row.setAttribute("data-wk", "8");
      row.innerHTML = "<td class=\"wk\">Wk 8</td><td class=\"who\" title=\"Mario (Niños Bonitos)\"><span class=\"hrow\"><span class=\"cup\" aria-hidden=\"true\">🏆</span><b class=\"nm\">Mario</b></span><span class=\"tag\">Niños Bonitos</span></td><td class=\"num\">12/14<span class=\"hnote\">won TB (41 vs 28)</span></td><td class=\"num cash\">$100<span class=\"dim\">10 entries</span></td>";
      var firstData = hall.querySelector("tbody tr") || hall.querySelector("tr:not(:first-child)");
      if (firstData && firstData.parentNode) firstData.parentNode.insertBefore(row, firstData);
      else (hall.querySelector("tbody") || hall).appendChild(row);
      var tot = hall.querySelector("tr.tot .cash");
      if (tot) tot.textContent = "$830";
    }
    Object.keys(BYE_WEEKS).forEach(function (wk) {
      if (hall.querySelector("[data-wk=\"" + wk + "\"]")) return;
      var row = document.createElement("tr");
      row.setAttribute("data-wk", wk);
      row.setAttribute("data-bye", "1");
      row.innerHTML = "<td class=\"wk\">Wk " + wk + "</td><td class=\"who\" title=\"Bye week\"><span class=\"hrow\"><span class=\"cup\" aria-hidden=\"true\">🏈</span><b class=\"nm\">BYE WEEK</b></span><span class=\"tag\">the whole league was on bye</span></td><td class=\"num\">—<span class=\"hnote\">site outage</span></td><td class=\"num\">—<span class=\"dim\">no payout</span></td>";
      var first = hall.querySelector("tr[data-wk]");
      if (first && first.parentNode) first.parentNode.insertBefore(row, first);
      else (hall.querySelector("tbody") || hall).appendChild(row);
    });
  }
  function syncNav(b) {
    var wk = b && b.week, cur = b && (b.current_week || b.week);
    var label = $("#week-now");
    if (label && wk) label.textContent = BYE_WEEKS[wk] ? ("Week " + wk + " · BYE") : ("Week " + wk);
    var prev = $("#week-prev"), next = $("#week-next");
    if (prev) prev.disabled = !(wk > 1);
    if (next) next.disabled = cur ? !(wk < cur) : !(wk < 30);
    var note = $("#week-note");
    if (!note) return;
    if (b && b.archive) return;
    if (wk && BYE_WEEKS[wk]) { note.hidden = false; note.textContent = BYE_WEEKS[wk] + " (site outage). No champion."; }
    else if (cur && wk && wk !== cur) { note.hidden = false; note.textContent = "Past results. Picks are closed."; }
    else note.hidden = true;
  }
  function boardUrl() {
    var u = URL_;
    if (viewing) u += (u.indexOf("?") < 0 ? "?" : "&") + "week=" + viewing;
    return u;
  }
  function writeUrl(b) {
    var cur = b.current_week;
    var want = (cur && b.week === cur) ? location.pathname : (location.pathname + "?week=" + b.week);
    if (location.pathname + location.search !== want) history.pushState({week: b.week}, "", want);
  }
  function hallRowFor(week) {
    var hall = $(".hall table");
    if (!hall) return null;
    var marked = hall.querySelector("[data-wk=\"" + week + "\"]");
    if (marked && !marked.getAttribute("data-bye")) return marked;
    var rows = hall.querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var cell = rows[i].querySelector(".wk");
      if (cell && String(cell.textContent).replace(/\D/g, "") === String(week)) return rows[i];
    }
    return null;
  }
  function showArchive(week) {
    var cur = (applied && applied.current_week) || null;
    viewing = week;
    applied = {week: week, current_week: cur, archive: true, status: {week: week}};
    var row = hallRowFor(week);
    var name = row && row.querySelector(".nm") ? row.querySelector(".nm").textContent : "";
    var score = "";
    if (row) {
      var nums = row.querySelectorAll(".num");
      if (nums[0]) {
        var main = nums[0].childNodes[0] ? String(nums[0].childNodes[0].textContent || "").trim() : "";
        var extra = nums[0].querySelector(".hnote");
        score = main + (extra ? " " + extra.textContent.trim() : "");
      }
    }
    document.title = "Fam Bash Pickems · Week " + week;
    var meta = $(".meta");
    if (meta && meta.childNodes[0] && meta.childNodes[0].nodeType === 3) meta.childNodes[0].textContent = "Week " + week + " · ";
    var eyebrow = $(".eyebrow span:last-child");
    if (eyebrow) eyebrow.textContent = "Week " + week + " · detailed board not available";
    var card = $("#status-card");
    if (card) { card.setAttribute("data-submit", "closed"); card.setAttribute("data-week", String(week)); }
    var picksHead = document.querySelector("#sec-picks thead tr");
    if (picksHead) {
      var firstTh = picksHead.querySelector("th:not([data-game])");
      while (picksHead.lastChild && picksHead.lastChild !== firstTh) picksHead.removeChild(picksHead.lastChild);
    }
    var stBody = document.querySelector("#standings tbody");
    if (stBody) {
      clearRows(stBody);
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.style.cssText = "text-align:center;padding:18px;color:#d6c4a8";
      td.textContent = name ? (name + " is in the Hall for this week. Game-by-game picks were not saved.") : "This week's board was not saved.";
      tr.appendChild(td);
      stBody.appendChild(tr);
    }
    var picks = document.querySelector("#sec-picks tbody");
    if (picks) {
      clearRows(picks);
      var tr2 = document.createElement("tr");
      var td2 = document.createElement("td");
      td2.colSpan = 8;
      td2.style.cssText = "text-align:center;padding:18px;color:#d6c4a8";
      td2.textContent = "Detailed picks aren't available for Week " + week + ".";
      tr2.appendChild(td2);
      picks.appendChild(tr2);
    }
    syncNav(applied);
    var note = $("#week-note");
    if (note) {
      note.hidden = false;
      note.textContent = "Detailed board isn't available for Week " + week + "." + (name ? " Champion: " + name + (score ? " (" + score + ")." : ".") : " The slate was never saved.");
    }
    if (pushNext) { writeUrl(applied); pushNext = false; }
  }
  function boardNote(text) {
    var n = document.getElementById("board-error");
    if (!text) { if (n) n.hidden = true; return; }
    if (!n) {
      n = document.createElement("div");
      n.id = "board-error";
      n.setAttribute("role", "status");
      n.style.cssText = "margin:10px 0;padding:10px 12px;border-radius:10px;background:#3b2416;border:1px solid #f59e0b;color:#fde68a;font-size:14px";
      var card = $("#status-card");
      if (card && card.parentNode) card.parentNode.insertBefore(n, card);
      else document.body.appendChild(n);
    }
    n.textContent = text;
    n.hidden = false;
  }
  function showProblem(asked) {
    var same = applied && (!asked || applied.week === asked);
    if (asked && applied && applied.week !== asked) viewing = applied.week;
    boardNote(asked && !same ? ("Week " + asked + " isn't available. Still showing Week " + applied.week + ".") : (same ? "Scores did not refresh. Showing the last update." : "The board did not load. Refresh the page in a minute."));
  }

  function refresh() {
    if (busy) return;
    busy = true;
    var asked = viewing;
    var u = boardUrl() + (boardUrl().indexOf("?") < 0 ? "?" : "&") + "t=" + Date.now();
    fetch(u, {cache: "no-store"})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (b) {
        if (b && b.status && !b.degraded) {
          applied = b;
          if (!viewing) viewing = b.current_week || b.week;
          boardNote("");
          apply(b);
          if (pushNext) { writeUrl(b); pushNext = false; }
        } else if (b && b.status && b.degraded && !applied) {
          boardNote("Scores are incomplete. Refresh the page in a minute.");
          apply(b);
        } else if (asked && hallRowFor(asked)) {
          showArchive(asked);
        } else showProblem(asked);
      })
      .catch(function () { showProblem(asked); pushNext = false; })
      .then(function () { busy = false; });
  }
  function go(week) {
    if (busy || !week || week < 1 || week > 30) return;
    pushNext = true;
    viewing = week;
    refresh();
  }

  function bindNav() {
    var prev = $("#week-prev"), next = $("#week-next");
    if (prev) prev.addEventListener("click", function () {
      var w = (applied && applied.week) || viewing;
      if (w > 1) go(w - 1);
    });
    if (next) next.addEventListener("click", function () {
      var w = (applied && applied.week) || viewing;
      var cur = applied && applied.current_week;
      if (cur && w < cur) go(w + 1);
    });
    window.addEventListener("popstate", function () {
      viewing = weekFromLocation();
      refresh();
    });
  }
  function start() { if (timer) clearInterval(timer); timer = setInterval(refresh, EVERY); }
  bindNav();
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { refresh(); start(); }
  });
  if (document.visibilityState !== "hidden") { refresh(); start(); }
  window.PickemsLive = {refresh: refresh, apply: apply};
})();
