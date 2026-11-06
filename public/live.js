/* Fam Bash Pickems live board (no dependencies). Contract: /workspace/pickems/HOOKS.md
   While the tab is visible: fetch /board/current.json right away and every 60 s (cache-busted), and right away when
   the tab becomes visible again; then patch the page in place through data hooks. Missing hooks are no-ops.
   Web entries: each poll also reads the public /api/entries?week=N (Turso, Monday picks + tiebreakers already
   omitted until Sunday is final) and merges any entry the board doesn't have yet as an unpaid row (cloned from an
   build_site <template data-row> or an existing row, marked data-web="1"), scored with the board's results by the same rules as pickems_status, so a new
   entry shows within a poll instead of waiting for the box sync. Once the sync puts it on the board, the row is
   adopted in place (no reload); if the entry disappears from the server, the row is removed.
   Edits (added 2026-10-13): a synced web row (player.online + player.entry) shows the entry's CURRENT picks from
   /api/entries, not the board JSON's copy (applyEdits). The board JSON only changes when the box sync publishes (every
   ~10 min + deploy), so before this a "Picks updated!" change stayed invisible on the board until then and looked like
   the edit had failed. Only games the board shows (not hidden) and picks the API sends (Monday picks are omitted until
   Sunday is final) are overlaid; paper players and merged rows are never touched; scores, splits, ranks recomputed.
   A new week, or a real board player added/removed, triggers ONE full reload instead (never a loop).
   Paid (Turso is the source of truth for web entries, toggled in /admin): when /api/entries says paid_live, each poll and
   page load applies every entry's paid to the board players it belongs to (synced web rows matched on player.entry/key,
   merged rows directly; paper players never), recomputes status.payout + text.payout, then paints the paid badges (.pdc),
   #unpaid-n, #owes and the tr.unpaid red-pulse class with exactly the markup build_site's pickems:board listener writes, before dispatching the event. The
   listener reads the same updated players, so both write identical text and never fight. No paid_live = board JSON wins.
   Void (Turso is the source of truth, toggled in /admin): each /api/entries row carries void (boolean). applyVoid() copies it
   onto the board's web players (same matching as paid; paper players keep the board JSON's flag) and recomputes leaders:
   a voided player stays on the board with its picks, score and rank but is never a leader (if everyone tied for first is
   void, the next best non-void player leads), same rule as pickems_status. paintPaid() then toggles tr.void (the VOID stamp)
   and drops tr.unpaid on voided rows, so the stamp replaces the red unpaid pulse; it shows / clears within one poll.
   Deletes: /api/entries lists "tombstones" (names deleted in /admin with no live entry). On each successful poll, board
   players that are web entries (online, matched on player.entry) with a tombstoned name and no live entry are dropped from
   the board handed to the hooks and listeners (ranks, leaders, entries, pot, payout, splits recomputed) and their rows get
   hidden + data-tomb="1" (never removed, so a restore just unhides them). Never because an entry is merely missing or a
   poll failed (the last good list is kept); paper players are never touched. Tombstoned keys are ignored by the reload check,
   so neither the hide nor the sync's later publish without that player reloads the page.
   Pick lock (the first kickoff): past status.submit_close_iso (or #status-card[data-submit-close]) the page is shown closed even if
   the board JSON hasn't changed: data-submit="closed", data-picks="locked", lock text "All picks locked" (see below).
   Live scores straight from ESPN (added 2026-10-12): while any (non-hidden) game is live or inside its kickoff window
   (30 min before to 6 h after) and the tab is visible, each poll also GETs the ESPN scoreboard (same URL + team-pair
   matching + FIX abbreviations as sync_scores.py), through the same-origin proxy GET /api/games?live=1&week=N&dates=YYYY
   (browsers get no CORS header from ESPN, so not fetched directly; edge-cached 15 s). espnOverlay() fills the
   gaps where the published board is behind: live score/clock (games[].score/clock, status.live_games, state) and, when
   ESPN says final, the result (status final, winner, pick-win/pick-loss cells, scores, games_final, splits, ranks,
   leaders via restat, so void still never leads). A game the board already has final is never touched (board wins).
   Hidden games (Monday pick / tiebreaker before Sunday is final) are skipped entirely; sunday_final, paid, void,
   tiebreakers and the winner banner always come from the board. mnf_total (+ tiebreaker_off) only once the board has
   revealed tiebreakers. status.text.updated = time of the last good ESPN refresh. Every failure (CORS, network, bad
   JSON, wrong week) is silent and falls back to the board; ESPN data older than 3 min or older than the board is dropped.
   Optional config before this script: window.PICKEMS_LIVE = {url: "/board/current.json", interval: 60000,
   entries: "/api/entries" (false = no merge), espn: <scoreboard url> (false = off)}. Fires document "pickems:board" (detail = board incl. merged players,
   which carry web: true). Hook names map to status.text keys; "leader-short" reads text.leader_short. */
(function () {
  "use strict";
  var cfg = window.PICKEMS_LIVE || {};
  var URL_ = cfg.url || "/api/board", EVERY = cfg.interval || 60000, RELOAD_KEY = "pickems-live-reloaded";
  var ENTRIES = cfg.entries === false ? null : (cfg.entries || "/api/entries");
  // ESPN scoreboard via the same-origin proxy (GET /api/games?live=1: ESPN's CORS header isn't reliable in real browsers)
  var ESPN = cfg.espn === false ? null : (cfg.espn || "/api/games?live=1");
  var lastEspn = null, ESPN_MAX_AGE = 180000;
  var timer = null, busy = false, first = null, lastEntries = null, lastPaidLive = false, lastTombs = [], lastReal = null, closeTimer = null;
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
  function merge(b, entries, paidLive) {
    if (!b || !b.players || !b.games || !entries || !entries.length) return b;
    var st = b.status || {}, revealed = !!st.sunday_final, abbr = b.abbr || {};
    var ab = function (t) { return abbr[t] || String(t).slice(0, 3).toUpperCase(); };
    var keys = {}, names = {};
    b.players.forEach(function (p) { keys[p.key] = 1; names[nameKey(p.name)] = 1; if (p.entry != null) names[nameKey(p.entry)] = 1; });
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
               rank: 0, score: score, leader: false, paid: !!(paidLive && en.paid === true), void: en.void === true, picks: picks, web: true};
      if (revealed) { p.tiebreaker = tb != null && isFinite(tb) ? Math.trunc(tb) : null;
        if (p.tiebreaker != null && b.mnf_total != null) p.tiebreaker_off = Math.abs(p.tiebreaker - Number(b.mnf_total)); }
      added.push(p);
    });
    if (!added.length) return b;
    var out = JSON.parse(JSON.stringify(b));
    restat(out, out.players.concat(added));
    out.web_merged = added.length;
    return out;
  }

  // ... rest of file truncated in this example for length; full content will be pushed in next step
