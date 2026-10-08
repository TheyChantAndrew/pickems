/* Fam Bash Pickems admin portal: paid toggles (see HOOKS.md ADMIN_HOOKS). No dependencies, text-only DOM (never innerHTML).
   Token: the URL fragment #k=<token> (fragments never reach the server or a Referer); sent only as Authorization: Bearer.
   Data:  GET /api/admin/paid?week=N (DB entries: name, tag, submitted, paid, paid_at) + the public /board/weekN.json for
          display labels (e.g. "MRod") and paper entries (board-only, read-only here: their paid flag lives in the week file).
   Save:  POST /api/admin/paid {week, name, paid}; the row shows Saving… -> Saved ✓, or reverts with an error + Retry.
   Delete: the card's small Delete button (web entries only) opens #adm-dlg (name, tag, paid status, paid / MNF-started
          warnings; focus trapped, Esc cancels); its red Delete POSTs /api/admin/delete {week, name}. Success removes the
          card and updates the totals; any failure shows the error in the dialog and keeps the card. The server logs the
          row (restorable) and refuses with 409 once Monday night is over (delete_state from GET /api/admin/paid). */
(function () {
  "use strict";
  var TZ = "America/Los_Angeles";
  var token = (/(?:^|[#&])k=([^&]+)/.exec(location.hash || "") || [])[1] || "";
  try { token = decodeURIComponent(token); } catch (e) { token = ""; }
  var $ = function (id) { return document.getElementById(id); };
  var state = {week: null, fee: 10, live: false, rows: [], paper: [], pending: 0, loadSeq: 0, del: null};

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
        if (!r.ok || !j.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; e.code = j.code; throw e; }
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
      if (!r.paper) {
        var del = li.querySelector(".adm-del"); del.hidden = false;
        del.setAttribute("aria-label", "Delete " + r.label);
        del.addEventListener("click", function () { openDel(r, del); });
      }
      paintRow(r); setState(r, "", "");
      list.appendChild(li);
    });
    if (!list.firstChild) { var li = document.createElement("li"); li.className = "adm-empty"; li.textContent = "No entries yet for Week " + state.week + "."; list.appendChild(li); }
    totals();
  }

  // ---- delete: confirm dialog (native <dialog> + explicit focus trap), then POST /api/admin/delete ----
  var dlg = $("adm-dlg"), dlgOk = $("adm-dlg-ok"), dlgCancel = $("adm-dlg-cancel"), cur = null, opener = null, busy = false, toastT = null;
  function dlgErr(text) { var e = $("adm-dlg-err"); e.textContent = text || ""; e.hidden = !text; }
  function toast(text) {
    var t = $("adm-toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 5000);
  }
  function openDel(r, btn) {
    if (busy || dlg.open) return;
    cur = r; opener = btn;
    var ds = state.del || {};
    $("adm-dlg-title").textContent = "Delete " + r.label + "?";
    var tg = $("adm-dlg-tag"); tg.textContent = r.tag || ""; tg.hidden = !r.tag;
    var pd = $("adm-dlg-paid"); pd.textContent = r.paid ? "PAID" : "UNPAID · owes $" + state.fee; pd.classList.toggle("is-paid", !!r.paid);
    $("adm-dlg-sub").textContent = (r.label !== r.name ? "Entry name: " + r.name + " · " : "") + "Submitted " + fmt(r.created_at) + " · Week " + state.week;
    var pw = $("adm-dlg-paidwarn"); pw.textContent = "Marked PAID ($" + state.fee + "). Deleting removes their payment from the totals."; pw.hidden = !r.paid;
    var mw = $("adm-dlg-mnfwarn");
    mw.textContent = "Monday night's game has already started. Deleting now pulls their picks off the board while the week is still being decided.";
    mw.hidden = !(ds.mnf_started && !ds.blocked);
    dlgErr(ds.blocked ? ds.message : "");
    dlgOk.disabled = !!ds.blocked; dlgCancel.disabled = false; dlgOk.textContent = "Delete";
    dlg.setAttribute("data-name", r.name);
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    dlgCancel.focus();
  }
  function closeDel() {
    if (busy) return;
    if (dlg.open) { if (typeof dlg.close === "function") dlg.close(); else dlg.removeAttribute("open"); }
    cur = null;
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }
  function confirmDel() {
    if (!cur || busy || dlgOk.disabled) return;
    var r = cur; busy = true; state.pending++;
    dlgOk.disabled = dlgCancel.disabled = true; dlgOk.textContent = "Deleting…"; dlgErr("");
    if (r.el) r.el.setAttribute("data-state", "deleting");
    api("POST", "/api/admin/delete", {week: state.week, name: r.name}).then(function () {
      busy = false;
      var k = nameKey(r.name), idx = -1;
      state.rows.forEach(function (x, i) { if (nameKey(x.name) === k) idx = i; });
      var next = idx >= 0 ? (state.rows[idx + 1] || state.rows[idx - 1]) : null;
      state.rows = state.rows.filter(function (x) { return nameKey(x.name) !== k; });
      Array.prototype.forEach.call($("adm-list").querySelectorAll("li.adm-row"), function (li) {
        if (li === r.el || nameKey(li.getAttribute("data-name")) === k && !li.classList.contains("is-paper")) li.parentNode.removeChild(li);
      });
      if (!$("adm-list").querySelector("li")) render(); else totals();
      opener = next && next.el ? next.el.querySelector(".adm-del") : $("adm-refresh");
      closeDel();
      toast("Deleted " + r.label + ". Totals updated.");
    }, function (e) {
      busy = false;
      if (r.el) r.el.setAttribute("data-state", "idle");
      dlgOk.textContent = "Delete"; dlgCancel.disabled = false;
      if (e.status === 409 && e.code === "FINISHED") { state.del = {blocked: true, message: e.message}; dlgOk.disabled = true; dlgErr(e.message); }
      else {
        dlgOk.disabled = false;
        dlgErr(e.status === 401 ? "This admin link isn't valid any more. Nothing was deleted."
             : e.status === 429 ? e.message + " Nothing was deleted."
             : e.status === 404 ? "That entry isn't in the database any more (maybe already deleted). Tap Refresh after closing this."
             : "Couldn't delete (" + e.message + "). Nothing changed; try again.");
      }
      (dlgOk.disabled ? dlgCancel : dlgOk).focus();
    }).then(function () { state.pending--; });
  }
  dlgCancel.addEventListener("click", closeDel);
  dlgOk.addEventListener("click", confirmDel);
  dlg.addEventListener("cancel", function (ev) { ev.preventDefault(); closeDel(); });    // Esc
  dlg.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape") { ev.preventDefault(); closeDel(); return; }
    if (ev.key !== "Tab") return;                                                        // keep focus inside the dialog
    var f = Array.prototype.filter.call(dlg.querySelectorAll("button"), function (b) { return !b.disabled && !b.hidden; });
    if (!f.length) { ev.preventDefault(); return; }
    var i = f.indexOf(document.activeElement);
    if (ev.shiftKey && i <= 0) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && (i === -1 || i === f.length - 1)) { ev.preventDefault(); f[0].focus(); }
  });

  function load(week) {
    var seq = ++state.loadSeq;
    $("adm-week").disabled = true;
    return Promise.all([api("GET", "/api/admin/paid" + (week ? "?week=" + encodeURIComponent(week) : "")),
                        week ? board(week) : Promise.resolve(null)]).then(function (res) {
      var j = res[0], b = res[1];
      if (seq !== state.loadSeq) return;
      if (!week) return load(j.week);                // first load: the server picks the current week
      state.week = j.week; state.fee = Number(j.fee || 10); state.live = !!j.paid_live; state.del = j.delete_state || null;
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
  $("adm-refresh").addEventListener("click", function () { if (!state.pending && !dlg.open) load(state.week); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && state.week && !state.pending && !dlg.open) load(state.week);
  });
  if (!token) { msg("Open the full admin link (it ends with #k=…). This page doesn't work without it."); $("adm-owes").textContent = "–"; return; }
  load(null);
  window.PickemsAdmin = {state: state, load: load, openDel: openDel};
})();
