/* Fam Bash Pickems admin portal: paid toggles (see HOOKS.md ADMIN_HOOKS). No dependencies, text-only DOM (never innerHTML).
   Token: the URL fragment #k=<token> (fragments never reach the server or a Referer); sent only as Authorization: Bearer.
   Data:  GET /api/admin/paid?week=N (DB entries: name, tag, submitted, paid, paid_at) + the public /board/weekN.json for
          display labels (e.g. "MRod") and paper entries (board-only, read-only here: their paid flag lives in the week file).
   Save:  POST /api/admin/paid {week, name, paid}; the row shows Saving… -> Saved ✓, or reverts with an error + Retry. */
(function () {
  "use strict";
  var TZ = "America/Los_Angeles";
  var token = (/(?:^|[#&])k=([^&]+)/.exec(location.hash || "") || [])[1] || "";
  try { token = decodeURIComponent(token); } catch (e) { token = ""; }
  var $ = function (id) { return document.getElementById(id); };
  var state = {week: null, fee: 10, live: false, rows: [], paper: [], pending: 0, loadSeq: 0};

  function nameKey(n) { return String(n == null ? "" : n).trim().toLowerCase().replace(/\s+/g, " "); }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
  function stripTag(t) { return String(t == null ? "" : t).replace(/^[() ]+|[() ]+$/g, ""); }
  function playerKey(name, tag) { return slug(name + " " + stripTag(tag)) || "player"; }
  function fmt(iso) {
    var d = new Date(iso); if (!iso || isNaN(d)) return "";
    try { return new Intl.DateTimeFormat("en-US", {timeZone: TZ, weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit"}).format(d) + " PT"; }
    catch (e) { return d.toISOString(); }
  }
  function msg(text, info) {
    var m = $("adm-msg"); m.textContent = text || ""; m.hidden = !text; m.classList.toggle("is-info", !!info);
  }
  function api(method, path, body) {
    var opt = {method: method, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer",
               headers: {"Authorization": "Bearer " + token, "Accept": "application/json"}};
    if (body) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function board(week) {
    return fetch("/board/week" + encodeURIComponent(week) + ".json?t=" + Date.now(), {cache: "no-store", credentials: "omit"})
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  // ---- totals: every entry (DB + paper) counts toward the pot; collected = fee x paid ----
  function totals() {
    var all = state.rows.concat(state.paper), fee = state.fee;
    var paid = all.filter(function (r) { return r.paid; }), owe = all.filter(function (r) { return !r.paid; });
    $("adm-entries").textContent = String(all.length);
    $("adm-pot").textContent = "$" + fee * all.length;
    $("adm-collected").textContent = "$" + fee * paid.length;
    $("adm-owed").textContent = "$" + fee * owe.length;
    var o = $("adm-owes"); while (o.firstChild) o.removeChild(o.firstChild);
    o.classList.toggle("is-clear", !owe.length && all.length > 0);
    if (!all.length) { o.textContent = "No entries yet this week."; return; }
    if (!owe.length) { o.textContent = "Everyone has paid ✅"; return; }
    o.appendChild(document.createTextNode("Still owes: "));
    var b = document.createElement("b"); b.textContent = owe.map(function (r) { return r.label; }).join(", "); o.appendChild(b);
  }

  function paintRow(r) {
    var li = r.el, cb = li.querySelector(".adm-cb");
    li.classList.toggle("is-paid", !!r.paid);
    cb.checked = !!r.paid;
    li.querySelector(".adm-lbl").textContent = r.paid ? "PAID" : "OWES $" + state.fee;
    var pa = li.querySelector(".adm-paidat");
    pa.textContent = r.paid ? (r.paid_at ? "Paid " + fmt(r.paid_at) : (r.paper ? "" : "Paid before the portal")) : "";
    pa.hidden = !pa.textContent;
  }
  function setState(r, cls, text) {
    var s = r.el.querySelector(".adm-state");
    s.className = "adm-state" + (cls ? " " + cls : ""); s.textContent = text || "";
    r.el.setAttribute("data-state", cls ? cls.replace("is-", "") : "idle");
  }

  function save(r, want) {
    var li = r.el, cb = li.querySelector(".adm-cb"), retry = li.querySelector(".adm-retry");
    var seq = (r.seq = (r.seq || 0) + 1);
    retry.hidden = true; cb.disabled = true; cb.checked = want; li.classList.toggle("is-paid", want);
    setState(r, "is-saving", "Saving…"); state.pending++;
    api("POST", "/api/admin/paid", {week: state.week, name: r.name, paid: want}).then(function (j) {
      if (seq !== r.seq) return;
      r.paid = !!j.paid; r.paid_at = j.paid_at || null;
      paintRow(r); totals(); setState(r, "is-saved", "Saved ✓");
      setTimeout(function () { if (seq === r.seq && r.el.getAttribute("data-state") === "saved") setState(r, "", ""); }, 4000);
    }, function (e) {
      if (seq !== r.seq) return;
      paintRow(r);                                   // revert to the last saved value
      setState(r, "is-error", e.status === 401 ? "Link not valid" : e.status === 429 ? "Too many tries, wait" : "Couldn't save");
      retry.hidden = false; retry.onclick = function () { save(r, want); };
      if (e.status === 401 || e.status === 429) msg(e.message);
    }).then(function () { if (seq === r.seq) cb.disabled = !state.live; state.pending--; });
  }

  function render() {
    var list = $("adm-list"), tpl = $("adm-row-tpl");
    while (list.firstChild) list.removeChild(list.firstChild);
    state.rows.concat(state.paper).forEach(function (r) {
      var li = tpl.content.firstElementChild.cloneNode(true); r.el = li;
      li.setAttribute("data-name", r.name); li.setAttribute("data-key", r.key);
      li.querySelector(".adm-name").textContent = r.label;
      li.querySelector(".adm-name").title = r.label !== r.name ? r.label + " = " + r.name : r.name;
      var tg = li.querySelector(".adm-tag"); if (r.tag) tg.textContent = r.tag; else tg.hidden = true;
      if (r.label !== r.name) { var real = document.createElement("span"); real.className = "adm-real"; real.textContent = r.name; tg.parentNode.insertBefore(real, tg.nextSibling); }
      li.querySelector(".adm-when").textContent = r.paper ? "Paper entry · paid is set in the week file" : "Submitted " + fmt(r.created_at);
      var cb = li.querySelector(".adm-cb");
      cb.setAttribute("aria-label", "Paid: " + r.label);
      if (r.paper) { li.classList.add("is-paper"); cb.disabled = true; }
      else { cb.disabled = !state.live; cb.addEventListener("change", function () { save(r, cb.checked); }); }
      paintRow(r); setState(r, "", "");
      list.appendChild(li);
    });
    if (!list.firstChild) { var li = document.createElement("li"); li.className = "adm-empty"; li.textContent = "No entries yet for Week " + state.week + "."; list.appendChild(li); }
    totals();
  }

  function load(week) {
    var seq = ++state.loadSeq;
    $("adm-week").disabled = true;
    return Promise.all([api("GET", "/api/admin/paid" + (week ? "?week=" + encodeURIComponent(week) : "")),
                        week ? board(week) : Promise.resolve(null)]).then(function (res) {
      var j = res[0], b = res[1];
      if (seq !== state.loadSeq) return;
      if (!week) return load(j.week);                // first load: the server picks the current week
      state.week = j.week; state.fee = Number(j.fee || 10); state.live = !!j.paid_live;
      var players = (b && String(b.week) === String(j.week) && b.players) || [];
      var byEntry = {}, byKey = {}, byName = {};
      players.forEach(function (p) { if (p.entry != null) byEntry[nameKey(p.entry)] = p; byKey[p.key] = p; byName[nameKey(p.name)] = p; });
      var used = {};
      state.rows = j.entries.map(function (en) {
        var p = byEntry[nameKey(en.name)] || byKey[playerKey(en.name, en.tag)] || byName[nameKey(en.name)];
        if (p) used[p.key] = 1;
        return {name: en.name, key: p ? p.key : playerKey(en.name, en.tag), label: p && p.name ? p.name : en.name,
                tag: p && p.tag ? p.tag : stripTag(en.tag), created_at: en.created_at, paid: !!en.paid, paid_at: en.paid_at || null};
      });
      var paperNames = {}; (j.board_names || []).forEach(function (n) { paperNames[nameKey(n)] = 1; });
      state.paper = players.filter(function (p) {
        return !used[p.key] && p.online !== true && (paperNames[nameKey(p.entry != null ? p.entry : p.name)] || p.online === false);
      }).map(function (p) {
        return {name: p.entry != null ? p.entry : p.name, key: p.key, label: p.name, tag: p.tag, paid: !!p.paid, paper: true};
      });
      var sel = $("adm-week"); while (sel.firstChild) sel.removeChild(sel.firstChild);
      (j.weeks || [j.week]).slice().reverse().forEach(function (w) {
        var o = document.createElement("option"); o.value = String(w); o.textContent = "Week " + w + (w === j.current_week ? " (now)" : "");
        if (w === j.week) o.selected = true; sel.appendChild(o);
      });
      sel.disabled = false;
      $("adm-sub").textContent = "Fam Bash Pickems · Week " + j.week + " · $" + state.fee + " entry";
      msg(state.live ? "" : "Week " + j.week + " payments are tracked in the week file (before the portal), so switches are read-only here.", true);
      render();
    }).catch(function (e) {
      if (seq !== state.loadSeq) return;
      $("adm-week").disabled = false;
      msg(e.status === 401 ? "This admin link isn't valid. Open the exact link you were sent (it ends with #k=…)."
          : e.status === 429 ? e.message : "Couldn't load entries (" + e.message + "). Check your connection and tap Refresh.");
      $("adm-owes").textContent = "–";
    });
  }

  $("adm-week").addEventListener("change", function () { load(Number(this.value)); });
  $("adm-refresh").addEventListener("click", function () { if (!state.pending) load(state.week); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.week && !state.pending) load(state.week);
  });
  if (!token) { msg("Open the full admin link (it ends with #k=…). This page doesn't work without it."); $("adm-owes").textContent = "–"; return; }
  load(null);
  window.PickemsAdmin = {state: state, load: load};
})();
