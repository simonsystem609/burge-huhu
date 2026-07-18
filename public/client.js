/* Bürge / Hühü — client. Browser globals: I18N, Cards, io
 *
 * Rendering model: the game is a persistent scene. Every visible card is ONE
 * long-lived DOM element in #card-layer, positioned purely with transforms.
 * A server view never rebuilds the board — it just re-targets transforms, so
 * every card movement (deal, draw, attack, beat, pickup, discard) is a real
 * animation of the same element, for humans and bots alike, and the layout
 * never jumps or reflows.
 */
(function () {
  'use strict';

  const socket = io({ reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 4000 });
  const { t, suitName, cardName } = window.I18N;
  const { cardHTML, cardBackHTML } = window.Cards;

  let lang = localStorage.getItem('burge_lang') || 'hu';
  let lastLobby = null;
  let peopleLooking = 0;

  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

  function renderMatchCount(count = peopleLooking) {
    peopleLooking = Number.isInteger(count) && count >= 0 ? count : 0;
    $('match-count').textContent = t(lang, 'peopleLooking').replace('{count}', peopleLooking);
  }

  // One shared duration for every card movement, adjustable from the menu.
  // Applied as a CSS custom property so JS timing and CSS transitions match.
  let ANIM_MS = 900;
  function clampAnim(ms) {
    return Math.max(300, Math.min(2500, Math.round(ms) || 900));
  }
  function applyAnimSpeed(ms) {
    ANIM_MS = clampAnim(ms);
    document.documentElement.style.setProperty('--anim-dur', ANIM_MS + 'ms');
    localStorage.setItem('burge_anim_ms', String(ANIM_MS));
    const sel = $('anim-speed');
    if (sel) sel.value = String(ANIM_MS);
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((c, i) => c === sb[i]);
  }

  // ── i18n application ─────────────────────────────────────────────
  function applyStaticI18n() {
    document.documentElement.lang = lang;
    qsa('[data-i18n]').forEach((el) => {
      el.textContent = t(lang, el.getAttribute('data-i18n'));
    });
    qsa('[data-i18n-ph]').forEach((el) => {
      el.setAttribute('placeholder', t(lang, el.getAttribute('data-i18n-ph')));
    });
    qsa('.lang').forEach((b) =>
      b.classList.toggle('active', b.getAttribute('data-lang') === lang)
    );
    renderMatchCount();
  }

  function setLang(next) {
    lang = next;
    localStorage.setItem('burge_lang', lang);
    applyStaticI18n();
    if ($('screen-lobby').classList.contains('active') && lastLobby) renderLobby(lastLobby);
    if ($('screen-game').classList.contains('active') && sceneView) settle(sceneView, true);
    buildRules();
  }

  function showScreen(id) {
    qsa('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ── Menu actions ─────────────────────────────────────────────────
  function myName() {
    const n = ($('name-input').value || '').trim();
    localStorage.setItem('burge_name', n);
    return n || (lang === 'hu' ? 'Játékos' : 'Player');
  }

  // Stable per-browser identity (shared with the UR game) — the server uses
  // it to hold our seat across disconnects so a closed tab can resume.
  function clientId() {
    let id = localStorage.getItem('bh_client_id');
    if (!id) {
      id = window.crypto && crypto.randomUUID
        ? crypto.randomUUID()
        : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('bh_client_id', id);
    }
    return id;
  }

  function myBotDelay() {
    return Number(localStorage.getItem('burge_bot_ms')) || 800;
  }

  $('btn-single').onclick = () =>
    socket.emit('singleplayer', {
      name: myName(),
      lang,
      bots: Number($('bot-count').value),
      botDelayMs: myBotDelay(),
      clientId: clientId(),
    });
  $('btn-create').onclick = () =>
    socket.emit('createRoom', { name: myName(), lang, botDelayMs: myBotDelay(), clientId: clientId() });
  // Switching games is a deliberate exit: give up our seats first so the
  // UR page's auto-resume doesn't bounce us straight back here.
  $('btn-goto-ur').onclick = () => {
    socket.emit('abandon', { clientId: clientId() });
    setTimeout(() => {
      window.location.href = '/ur/';
    }, 150);
  };
  $('btn-join').onclick = () => {
    const code = ($('code-input').value || '').trim().toUpperCase();
    if (code.length < 4) return toast(t(lang, 'err_no_room'));
    socket.emit('joinRoom', { code, name: myName(), clientId: clientId() });
  };
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

  // ── Matchmaking ──────────────────────────────────────────────────
  function showSearch(on) {
    $('search-modal').classList.toggle('show', on);
  }
  $('btn-matchmake').onclick = () => {
    showSearch(true);
    socket.emit('findMatch', { name: myName(), lang, botDelayMs: myBotDelay(), clientId: clientId() });
  };
  $('btn-cancel-match').onclick = () => {
    socket.emit('cancelMatch');
    showSearch(false);
  };

  // ── Lobby ────────────────────────────────────────────────────────
  $('btn-addbot').onclick = () => socket.emit('addBot');
  $('btn-start').onclick = () => socket.emit('startGame');
  $('btn-leave-lobby').onclick = () => {
    socket.emit('leaveRoom');
    showScreen('screen-menu');
  };
  $('btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(lastLobby ? lastLobby.code : '');
      toast(t(lang, 'copied'));
    } catch (_) {
      toast(lastLobby ? lastLobby.code : '');
    }
  };

  function renderLobby(payload) {
    lastLobby = payload;
    $('lobby-code').textContent = payload.code;
    const iAmHost = payload.seats.some((s) => s.sid === socket.id && s.isHost);
    const list = $('seat-list');
    list.innerHTML = '';
    payload.seats.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'seat';
      const isYou = s.sid === socket.id;
      let badges = '';
      if (s.isHost) badges += `<span class="badge host">${t(lang, 'host')}</span>`;
      if (isYou) badges += `<span class="badge you">${t(lang, 'you')}</span>`;
      if (s.isBot) badges += '<span class="badge bot">BOT</span>';
      const kick =
        iAmHost && !s.isHost
          ? `<button class="kick ghost small" data-seat="${s.id}">✕</button>`
          : '';
      li.innerHTML = `<span>${escapeHtml(s.name)}</span> ${badges} ${kick}`;
      list.appendChild(li);
    });
    list.querySelectorAll('.kick').forEach((b) => {
      b.onclick = () => socket.emit('removeSeat', { seatId: b.getAttribute('data-seat') });
    });

    const canAdd = payload.seats.length < payload.maxSeats;
    $('btn-addbot').style.display = iAmHost ? '' : 'none';
    $('btn-addbot').disabled = !canAdd;
    $('btn-start').style.display = iAmHost ? '' : 'none';
    $('btn-start').disabled = payload.seats.length < 2;
    $('lobby-hint').textContent = iAmHost
      ? payload.seats.length < 2
        ? t(lang, 'needPlayers')
        : ''
      : t(lang, 'waitingHost');
    showScreen('screen-lobby');
  }

  // ═══ Card scene ═══════════════════════════════════════════════════
  const CW = 92;
  const CH = 132;
  const PILE_SCALE = 0.63;
  const Z = { pile: 6, trump: 7, fan: 10, tableA: 20, tableD: 26, hand: 40, staged: 58, flight: 70, drag: 90 };

  let sceneView = null; // the view the scene currently represents
  let els = new Map(); // key -> element; key is a cardId or 'b<serial>' (hidden back)
  let fans = {}; // opponent seat -> ordered list of back keys
  let backSerial = 0;
  let timers = [];
  const discarding = new Set(); // cards mid-flight to the discard pile
  let staged = new Set(); // my cards staged for an attack (client-side only)
  let selectedDef = null; // hand card selected to defend with (click flow)
  // Local (unconfirmed) defense assignments: slot index -> hand card placed
  // on it. Nothing is sent to the server until the Beat button confirms, so
  // the player can freely swap cards around or change their mind. Slots
  // left without a card are picked up automatically on confirm.
  const pendingDef = new Map();
  // Live look at an OPPONENT's own tentative (unconfirmed) placement, relayed
  // by the server purely for display — never authoritative. Raw shape as
  // received: { seat, type: 'attack'|'defense', cards?, slots? }.
  let remotePreview = null;

  function clearSceneTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function resetScene() {
    clearSceneTimers();
    els.forEach((el) => el.remove());
    els = new Map();
    fans = {};
    discarding.clear();
    staged.clear();
    pendingDef.clear();
    selectedDef = null;
    remotePreview = null;
  }

  function leaveGameUi() {
    resetScene();
    sceneView = null;
    animQueue = [];
    clearTimeout(animTimer);
  }

  // ── Card elements ────────────────────────────────────────────────
  function makeCardEl(down) {
    const el = document.createElement('div');
    el.className = 'pcard' + (down ? ' down' : '');
    el.innerHTML =
      '<div class="pflip"><div class="pface front"></div><div class="pface back">' +
      cardBackHTML({}) +
      '</div></div>';
    $('card-layer').appendChild(el);
    return el;
  }
  function setFace(el, cardId) {
    el.querySelector('.pface.front').innerHTML = cardHTML(cardId, {});
    el.setAttribute('data-card', cardId);
  }
  function reveal(el, cardId) {
    setFace(el, cardId);
    el.classList.remove('down');
  }
  function conceal(el) {
    el.classList.add('down');
    el.removeAttribute('data-card');
  }
  function newBackKey() {
    backSerial += 1;
    return 'b' + backSerial;
  }
  function removeEl(key) {
    const el = els.get(key);
    if (el) {
      el.remove();
      els.delete(key);
    }
  }
  const STATE_CLASSES = ['clickable', 'dim', 'sel', 'staged', 'targetable', 'marked', 'pending', 'remote'];
  function stripStateClasses(el) {
    STATE_CLASSES.forEach((c) => el.classList.remove(c));
  }

  // ── Geometry ─────────────────────────────────────────────────────
  function gscale() {
    return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--card-scale')) || 1;
  }

  function anchors() {
    const L = $('card-layer').getBoundingClientRect();
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - L.left, y: r.top - L.top, w: r.width, h: r.height };
    };
    const fanRects = {};
    qsa('#opponents .opp').forEach((o) => {
      fanRects[Number(o.getAttribute('data-seat'))] = rel(o.querySelector('.fan'));
    });
    return {
      talon: rel($('talon-spot')),
      discard: rel($('discard-spot')),
      slots: rel($('slots-area')),
      hand: rel($('my-hand')),
      fans: fanRects,
    };
  }

  function applyTransform(el, p) {
    const x = p.x - CW / 2;
    const y = p.y - CH / 2;
    el.style.transform =
      'translate(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px)' +
      ' rotate(' + (p.rot || 0) + 'deg) scale(' + (p.scale || 1) + ')';
    el.style.zIndex = String(p.z || 1);
  }

  function place(el, p, opts) {
    opts = opts || {};
    if (opts.instant) el.classList.add('no-anim');
    // Always (re)set the per-flight duration override so a temporary value
    // can never stick to the element beyond its one flight.
    el.style.transitionDuration = opts.dur ? opts.dur + 'ms' : '';
    applyTransform(el, p);
    if (opts.instant) {
      void el.offsetWidth; // commit the jump before re-enabling transitions
      el.classList.remove('no-anim');
    }
  }

  function talonPos(a, s) {
    return { x: a.talon.x + a.talon.w / 2 + 12, y: a.talon.y + a.talon.h / 2, scale: PILE_SCALE * s, z: Z.pile };
  }
  function trumpPos(a, s) {
    return { x: a.talon.x + a.talon.w / 2 - 18, y: a.talon.y + a.talon.h / 2 + 8, rot: -18, scale: PILE_SCALE * s, z: Z.trump };
  }
  function discardPos(a, s, rot) {
    return { x: a.discard.x + a.discard.w / 2, y: a.discard.y + a.discard.h / 2, rot: rot == null ? 6 : rot, scale: PILE_SCALE * s, z: Z.flight };
  }
  function fanPos(a, s, seat, i, n) {
    const fr = a.fans[seat];
    const fscale = PILE_SCALE * s;
    if (!fr) return { x: -80, y: -80, scale: fscale, z: Z.fan };
    const cw = CW * fscale;
    const step = n > 1 ? Math.min(cw * 0.42, (fr.w - cw) / (n - 1)) : 0;
    const total = cw + step * (n - 1);
    const x0 = fr.x + (fr.w - total) / 2 + cw / 2;
    return { x: x0 + i * step, y: fr.y + fr.h / 2, scale: fscale, z: Z.fan + i };
  }
  function fanApprox(a, s, seat) {
    const fr = a.fans[seat];
    if (!fr) return { x: -80, y: -80, scale: PILE_SCALE * s, z: Z.flight };
    return { x: fr.x + fr.w / 2, y: fr.y + fr.h / 2, scale: PILE_SCALE * s, z: Z.flight };
  }
  // Attack/defense slots spread across the full play area; each defense
  // card lands clearly offset onto ITS attack card. If slots still have to
  // overlap, odd ones drop into a second row (zigzag) so the pairs stay
  // visually unambiguous.
  function slotPos(a, s, i, n, which) {
    const sr = a.slots;
    const cw = CW * s;
    const defOff = 26 * s;
    const slotW = cw + defOff;
    const gap = 30 * s;
    let stepX = slotW + gap;
    let zigzag = false;
    if (n * slotW + (n - 1) * gap > sr.w && n > 1) {
      stepX = (sr.w - slotW) / (n - 1);
      zigzag = stepX < slotW * 0.9;
    }
    const usedW = slotW + stepX * (n - 1);
    const first = sr.x + (sr.w - usedW) / 2 + cw / 2;
    const cx = first + i * stepX;
    let cy = sr.y + sr.h / 2 - 14 * s;
    if (zigzag && i % 2 === 1) cy += 34 * s;
    if (which === 'defense') {
      return { x: cx + defOff, y: cy + 30 * s, rot: 8, scale: s, z: Z.tableD + i };
    }
    return { x: cx, y: cy, scale: s, z: Z.tableA + i };
  }
  function handPos(a, s, i, n, raised) {
    const hr = a.hand;
    const cw = CW * s;
    const step = n > 1 ? Math.min(cw * 0.78, (hr.w - cw) / (n - 1)) : 0;
    const total = cw + step * (n - 1);
    const x0 = hr.x + (hr.w - total) / 2 + cw / 2;
    const y = hr.y + hr.h - (CH * s) / 2 - 4 - (raised ? 14 * s : 0);
    return { x: x0 + i * step, y, scale: s, z: Z.hand + i };
  }
  function stagedPos(a, s, j, m) {
    const hr = a.hand;
    const cw = CW * s;
    const step = cw * 0.82;
    const total = cw + step * (m - 1);
    const x0 = hr.x + (hr.w - total) / 2 + cw / 2;
    return { x: x0 + j * step, y: hr.y - CH * s * 0.42, scale: s, z: Z.staged + j };
  }
  function handCenter(a, s) {
    return { x: a.hand.x + a.hand.w / 2, y: a.hand.y + a.hand.h / 2, scale: s, z: Z.flight };
  }
  // Mirrors stagedPos, but anchored to an OPPONENT's fan instead of my own
  // hand — where their live attack-staging preview cards float. My own
  // staging lifts cards UP, toward the table, because my hand sits at the
  // bottom of the screen. An opponent's fan sits at the TOP, so "toward the
  // table" for them is DOWN — the opposite sign, or the cards fly off the
  // top of the viewport instead of settling into view.
  function remoteStagedPos(fr, s, j, m) {
    const fscale = PILE_SCALE * s;
    const cw = CW * fscale;
    const step = cw * 0.55;
    const total = cw + step * (m - 1);
    const x0 = fr.x + (fr.w - total) / 2 + cw / 2;
    return { x: x0 + j * step, y: fr.y + fr.h + CH * fscale * 0.42, scale: fscale, z: Z.staged + j };
  }

  // Display order for my hand: trump suit first, then the other suits.
  const RANK_ORDER = { VII: 0, VIII: 1, IX: 2, X: 3, Also: 4, Felso: 5, Kiraly: 6, Asz: 7 };
  const SUIT_ORDER = { piros: 0, zold: 1, makk: 2, tok: 3 };
  function sortHand(view) {
    return [...view.hand].sort((a, b) => {
      const ia = a.indexOf('-');
      const ib = b.indexOf('-');
      const sa = a.slice(0, ia);
      const sb = b.slice(0, ib);
      const ga = sa === view.trumpSuit ? -1 : SUIT_ORDER[sa];
      const gb = sb === view.trumpSuit ? -1 : SUIT_ORDER[sb];
      if (ga !== gb) return ga - gb;
      return RANK_ORDER[a.slice(ia + 1)] - RANK_ORDER[b.slice(ib + 1)];
    });
  }

  // ── Choreography primitives ──────────────────────────────────────
  // Get (or materialize) the element for a known card. A card coming out of
  // an opponent's hidden hand reveals one of their fan backs.
  function knownEl(cardId, fromSeat) {
    let el = els.get(cardId);
    if (el) return el;
    const a = anchors();
    const s = gscale();
    if (fromSeat != null && sceneView && fromSeat !== sceneView.you && fans[fromSeat] && fans[fromSeat].length > 0) {
      const key = fans[fromSeat].pop();
      el = els.get(key);
      els.delete(key);
    }
    if (!el) {
      el = makeCardEl(true);
      place(el, fromSeat != null ? fanApprox(a, s, fromSeat) : talonPos(a, s), { instant: true });
    }
    els.set(cardId, el);
    reveal(el, cardId);
    return el;
  }

  function flyToSlot(fromSeat, cardId, i, n, which) {
    const el = knownEl(cardId, fromSeat);
    stripStateClasses(el);
    const a = anchors();
    const s = gscale();
    const p = slotPos(a, s, i, n, which);
    p.z = Z.flight + i;
    place(el, p);
  }

  function flyToDiscard(cardId) {
    const el = els.get(cardId);
    if (!el) return;
    stripStateClasses(el);
    discarding.add(cardId);
    const a = anchors();
    const s = gscale();
    place(el, discardPos(a, s, Math.random() * 24 - 12));
    // Standalone timeout (not in `timers`): the absorption must happen even
    // if the next view arrives first and resets the choreography timers.
    setTimeout(() => {
      discarding.delete(cardId);
      el.remove();
      if (els.get(cardId) === el) els.delete(cardId);
    }, ANIM_MS + 80);
  }

  // A known card disappears into an opponent's hidden hand: flip it over,
  // fly it to their fan and re-key it as an anonymous back.
  function flyToFan(seat, cardId) {
    const el = els.get(cardId);
    if (!el) return;
    stripStateClasses(el);
    conceal(el);
    els.delete(cardId);
    const key = newBackKey();
    els.set(key, el);
    if (!fans[seat]) fans[seat] = [];
    fans[seat].push(key);
    const a = anchors();
    const s = gscale();
    place(el, fanApprox(a, s, seat));
  }

  // One card leaves the top of the talon towards a player.
  function flyDraw(seat, cardId) {
    const a = anchors();
    const s = gscale();
    const me = sceneView ? sceneView.you : 0;
    const el = makeCardEl(true);
    place(el, talonPos(a, s), { instant: true });
    if (seat === me && cardId) {
      els.set(cardId, el);
      place(el, handCenter(a, s));
      timers.push(setTimeout(() => reveal(el, cardId), 80));
    } else {
      const key = newBackKey();
      els.set(key, el);
      if (!fans[seat]) fans[seat] = [];
      fans[seat].push(key);
      place(el, fanApprox(a, s, seat));
    }
  }

  // The face-up trump card is drawn (always the very last card).
  function flyTrumpTo(seat) {
    const view = sceneView;
    const el = els.get(view.trumpCard);
    if (!el) {
      flyDraw(seat, seat === view.you ? view.trumpCard : null);
      return;
    }
    if (seat === view.you) {
      const a = anchors();
      const s = gscale();
      const p = handCenter(a, s);
      p.rot = 0;
      place(el, p);
    } else {
      flyToFan(seat, view.trumpCard);
    }
  }

  // ── Opponent panels (name/meta boxes; the cards float above them) ──
  function renderOpponentPanels(view) {
    const wrap = $('opponents');
    const wanted = [];
    for (let k = 1; k < view.players.length; k++) wanted.push((view.you + k) % view.players.length);
    const existing = {};
    qsa('#opponents .opp').forEach((el) => {
      existing[Number(el.getAttribute('data-seat'))] = el;
    });
    wanted.forEach((seat) => {
      const p = view.players[seat];
      let el = existing[seat];
      if (!el) {
        el = document.createElement('div');
        el.setAttribute('data-seat', String(seat));
        el.innerHTML = '<div class="fan"></div><div class="opp-name"></div><div class="opp-meta"></div>';
        wrap.appendChild(el);
      }
      el.className =
        'opp' +
        (p.isAttacker ? ' attacker' : '') +
        (p.isDefender ? ' defender' : '') +
        (p.finished ? ' finished' : '');
      el.querySelector('.opp-name').textContent = p.name;
      el.querySelector('.opp-meta').textContent = p.finished
        ? '#' + p.finishRank
        : p.count + ' 🂠' + (p.isBot ? ' · BOT' : '');
      delete existing[seat];
    });
    Object.values(existing).forEach((el) => el.remove());
  }

  // ── HUD (banner, buttons) ────────────────────────────────────────
  function renderHud(view) {
    const banner = $('turn-banner');
    banner.classList.toggle('you', !!view.yourTurn && view.phase !== 'over');
    if (view.phase === 'over') {
      banner.textContent = '';
    } else if (view.yourTurn) {
      banner.textContent = view.phase === 'defense' ? t(lang, 'defendPrompt') : t(lang, 'attackPrompt');
    } else {
      const who = view.players[view.phase === 'defense' ? view.defender : view.attacker];
      banner.textContent = t(lang, 'waitingFor', { name: who ? who.name : '' });
    }

    const myAttack = view.yourTurn && view.phase === 'attack';
    $('btn-attack').style.display = myAttack ? '' : 'none';
    if (myAttack) {
      const selection = [...staged];
      const legalNow = view.legal.some((m) => m.type === 'attack' && sameSet(m.cards, selection));
      $('btn-attack').disabled = !legalNow;
      $('btn-attack').textContent =
        t(lang, 'attackBtn') + (selection.length > 0 ? ` (${selection.length})` : '');
    }
    const myDefense = view.yourTurn && view.phase === 'defense';
    $('btn-beat').style.display = myDefense && view.table.slots.length > 0 ? '' : 'none';
    // Always confirmable: whatever has no card on it gets picked up.
    if (myDefense) $('btn-beat').disabled = false;
    $('btn-swap7').style.display = view.legal.some((m) => m.type === 'swap7') ? '' : 'none';
  }


  // ── Settle: reconcile the scene with a view (idempotent) ─────────
  // Choreography only pre-moves elements; settle is the actual renderer.
  // Whatever the animations did (or failed to do), after settle the scene
  // exactly matches the server view.
  function settle(view, instant) {
    const me = view.you;
    const opts = instant ? { instant: true } : {};

    // Everything that can affect layout must render BEFORE anchors are
    // measured, or card positions would be computed against stale geometry.
    renderOpponentPanels(view);
    renderHud(view);
    renderLog(view);
    if (view.phase === 'over') showOver(view);
    else $('overlay').classList.remove('show');

    const a = anchors();
    const s = gscale();

    // Static piles + labels.
    const talonBackVisible = view.talonCount - (view.trumpInTalon ? 1 : 0) > 0;
    $('talon-back').classList.toggle('empty', !talonBackVisible);
    $('talon-count').textContent = view.talonCount;
    $('discard-back').classList.toggle('empty', view.discardCount === 0);
    $('discard-count').textContent = view.discardCount;
    $('trump-suit-name').textContent = suitName(lang, view.trumpSuit);
    $('trump-picked-label').classList.toggle('show', view.trumpPicked);

    // Prune client-side selections that no longer apply.
    staged = new Set([...staged].filter((c) => view.hand.includes(c)));
    if (!(view.yourTurn && view.phase === 'attack')) staged.clear();
    if (!(view.yourTurn && view.phase === 'defense')) {
      pendingDef.clear();
      selectedDef = null;
    } else {
      [...pendingDef.entries()].forEach(([slot, card]) => {
        const sl = view.table.slots[slot];
        if (!sl || sl.defense != null || !view.hand.includes(card)) pendingDef.delete(slot);
      });
    }

    const myAttack = view.yourTurn && view.phase === 'attack';
    const myDefense = view.yourTurn && view.phase === 'defense';
    const beatable = new Set(
      myDefense ? view.legal.filter((m) => m.type === 'defend').map((m) => m.card) : []
    );

    // Desired placement of every known (face-up) card.
    const want = new Map();
    const handIds = sortHand(view);
    const assignedCards = new Set(pendingDef.values());
    const inHand = handIds.filter((c) => !staged.has(c) && !assignedCards.has(c));
    const stagedArr = handIds.filter((c) => staged.has(c));

    inHand.forEach((c, i) => {
      want.set(c, {
        pos: handPos(a, s, i, inHand.length, selectedDef === c),
        kind: 'hand',
        cls: {
          clickable: myAttack || (myDefense && beatable.has(c)),
          dim: myDefense && !beatable.has(c),
          sel: selectedDef === c,
        },
      });
    });
    stagedArr.forEach((c, j) => {
      want.set(c, {
        pos: stagedPos(a, s, j, stagedArr.length),
        kind: 'staged',
        cls: { staged: true, clickable: true },
      });
    });

    const nSlots = view.table.slots.length;
    view.table.slots.forEach((slot, i) => {
      const open = slot.defense == null;
      want.set(slot.attack, {
        pos: slotPos(a, s, i, nSlots, 'attack'),
        kind: 'attack',
        slot: i,
        cls: {
          targetable: myDefense && open && !pendingDef.has(i),
          clickable: myDefense && open,
        },
      });
      if (slot.defense) {
        want.set(slot.defense, {
          pos: slotPos(a, s, i, nSlots, 'defense'),
          kind: 'defense',
          slot: i,
          cls: {},
        });
      }
    });

    // Locally assigned (unconfirmed) defense cards sit on their slots.
    pendingDef.forEach((card, slot) => {
      want.set(card, {
        pos: slotPos(a, s, slot, nSlots, 'defense'),
        kind: 'pending-def',
        slot,
        cls: { pending: true, clickable: true },
      });
    });

    // Someone ELSE's live, unconfirmed placement — relayed purely for
    // display. Only rendered for cards not already accounted for above
    // (once a placement is actually confirmed, the real per-slot data a
    // few lines up already covers it and simply takes over the same
    // element). Revealing one specifically POPS a back-token out of their
    // fan via knownEl; snapshotted here so the fan-count reconciliation
    // below doesn't also top itself back up to their full hand count and
    // end up with one phantom back beyond what's actually in their hand.
    const previewBorrowed = {};
    const previewSeat = view.phase === 'attack' ? view.attacker : view.phase === 'defense' ? view.defender : null;
    const activePreview =
      remotePreview &&
      previewSeat != null &&
      previewSeat !== me &&
      remotePreview.seat === previewSeat &&
      remotePreview.type === view.phase
        ? remotePreview
        : null;
    if (activePreview && activePreview.type === 'attack') {
      const fr = a.fans[previewSeat];
      const cards = activePreview.cards || [];
      cards.forEach((card, j) => {
        if (want.has(card)) return;
        knownEl(card, previewSeat);
        previewBorrowed[previewSeat] = (previewBorrowed[previewSeat] || 0) + 1;
        const pos = fr ? remoteStagedPos(fr, s, j, cards.length) : fanApprox(a, s, previewSeat);
        want.set(card, { pos, kind: 'remote-preview', cls: { remote: true }, previewSeat });
      });
    } else if (activePreview && activePreview.type === 'defense') {
      (activePreview.slots || []).forEach(({ slot, card }) => {
        if (want.has(card)) return;
        const sl = view.table.slots[slot];
        if (!sl || sl.defense != null) return; // already resolved for real
        knownEl(card, previewSeat);
        previewBorrowed[previewSeat] = (previewBorrowed[previewSeat] || 0) + 1;
        want.set(card, {
          pos: slotPos(a, s, slot, nSlots, 'defense'),
          kind: 'remote-preview',
          slot,
          cls: { remote: true },
          previewSeat,
        });
      });
    }

    if (!view.trumpPicked) {
      // When the trump-VII swap is legal, the face-up trump itself glows
      // and is clickable — same action as the swap button, easier to find.
      const canSwap = view.legal.some((m) => m.type === 'swap7');
      want.set(view.trumpCard, {
        pos: trumpPos(a, s),
        kind: 'trump',
        cls: { targetable: canSwap, clickable: canSwap },
      });
    }

    // Snapshot which cards were shown as a remote preview in the PREVIOUS
    // pass, so any that dropped out below (un-staged/un-assigned before
    // confirming) can be returned to their owner's hidden fan.
    const prevPreview = [...els.entries()]
      .filter(([, el]) => el.getAttribute('data-kind') === 'remote-preview')
      .map(([key, el]) => ({ key, seat: Number(el.getAttribute('data-preview-seat')) }));

    want.forEach((w, cardId) => {
      let el = els.get(cardId);
      if (!el) {
        el = makeCardEl(true);
        els.set(cardId, el);
        place(el, talonPos(a, s), { instant: true });
        reveal(el, cardId);
      } else if (el.classList.contains('down')) {
        reveal(el, cardId);
      }
      el.setAttribute('data-kind', w.kind);
      if (w.slot != null) el.setAttribute('data-slot', String(w.slot));
      else el.removeAttribute('data-slot');
      if (w.previewSeat != null) el.setAttribute('data-preview-seat', String(w.previewSeat));
      else el.removeAttribute('data-preview-seat');
      STATE_CLASSES.forEach((k) => el.classList.toggle(k, !!w.cls[k]));
      place(el, w.pos, opts);
    });

    // Any previously-previewed card that's no longer wanted (dropped from
    // the preview, and not confirmed for real either) goes back to hiding
    // in its owner's fan.
    prevPreview.forEach(({ key, seat }) => {
      if (!want.has(key)) flyToFan(seat, key);
    });

    // Remove known cards that are no longer visible anywhere (unless they
    // are still mid-flight to the discard pile). Hidden backs ('b<serial>')
    // are reconciled per-fan below.
    [...els.keys()].forEach((key) => {
      if (/^b\d+$/.test(key)) return;
      if (!want.has(key) && !discarding.has(key)) removeEl(key);
    });

    // Opponent fans: reconcile back-token counts and spread them out. A
    // card currently borrowed out for a live preview (previewBorrowed)
    // still counts toward their hand size but isn't sitting in the fan, so
    // the target count excludes it — otherwise a phantom extra back would
    // appear alongside the revealed preview card.
    view.players.forEach((p) => {
      if (p.seat === me) return;
      if (!fans[p.seat]) fans[p.seat] = [];
      const list = fans[p.seat];
      const target = p.count - (previewBorrowed[p.seat] || 0);
      while (list.length > target) removeEl(list.pop());
      while (list.length < target) {
        const key = newBackKey();
        const el = makeCardEl(true);
        els.set(key, el);
        place(el, talonPos(a, s), { instant: true });
        list.push(key);
      }
      list.forEach((key, i) => {
        const el = els.get(key);
        if (!el) return;
        el.setAttribute('data-kind', 'fan');
        el.removeAttribute('data-slot');
        stripStateClasses(el);
        place(el, fanPos(a, s, p.seat, i, list.length), opts);
      });
    });

  }

  // ── Choreography: deal, exchange, refill ─────────────────────────
  function choreoDeal(view, steps) {
    const me = view.you;
    const n = view.players.length;
    const handIds = sortHand(view);
    const dealFly = Math.max(260, Math.round(ANIM_MS * 0.45));
    const dealStep = Math.max(70, Math.round(ANIM_MS * 0.14));
    let k = 0;
    for (let r = 0; r < 5; r++) {
      for (let seat = 0; seat < n; seat++) {
        const cardId = seat === me ? handIds[r] : null;
        const round = r;
        const theSeat = seat;
        steps.push({
          at: k * dealStep,
          fn: () => {
            const a = anchors();
            const s = gscale();
            const el = makeCardEl(true);
            place(el, talonPos(a, s), { instant: true });
            if (theSeat === me && cardId) {
              els.set(cardId, el);
              place(el, handPos(a, s, round, 5, false), { dur: dealFly });
              timers.push(setTimeout(() => reveal(el, cardId), Math.round(dealFly * 0.4)));
            } else {
              const key = newBackKey();
              els.set(key, el);
              if (!fans[theSeat]) fans[theSeat] = [];
              fans[theSeat].push(key);
              place(el, fanPos(a, s, theSeat, round, 5), { dur: dealFly });
            }
          },
        });
        k++;
      }
    }
    let tEnd = k * dealStep + dealFly;
    steps.push({
      at: tEnd,
      fn: () => {
        const a = anchors();
        const s = gscale();
        const el = makeCardEl(true);
        els.set(view.trumpCard, el);
        place(el, talonPos(a, s), { instant: true });
        reveal(el, view.trumpCard);
        place(el, trumpPos(a, s), { dur: dealFly });
      },
    });
    tEnd += dealFly + 80;
    return tEnd;
  }

  function findLastKey(log, key) {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].key === key) return log[i];
    }
    return null;
  }
  function findLastMove(log) {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].key === 'defend' || log[i].key === 'take') return log[i];
    }
    return null;
  }

  function choreoExchange(prev, view, steps) {
    const stag = Math.round(ANIM_MS * 0.45);
    const pSlots = prev.table.slots;
    const nSlots = view.table.slots;
    let tEnd = 0;

    if (pSlots.length === 0 && nSlots.length > 0) {
      // A fresh attack was laid out.
      nSlots.forEach((slot, i) => {
        steps.push({ at: i * stag, fn: () => flyToSlot(view.attacker, slot.attack, i, nSlots.length, 'attack') });
      });
      tEnd = (nSlots.length - 1) * stag + ANIM_MS;
    } else if (nSlots.length > 0 && pSlots.length === nSlots.length) {
      // One or more slots got their defense card.
      nSlots.forEach((slot, i) => {
        if (slot.defense && pSlots[i] && !pSlots[i].defense) {
          steps.push({ at: 0, fn: () => flyToSlot(view.defender, slot.defense, i, nSlots.length, 'defense') });
          tEnd = Math.max(tEnd, ANIM_MS);
        }
      });
    } else if (pSlots.length > 0 && nSlots.length === 0) {
      // The exchange resolved: beaten pairs -> discard, the rest -> defender.
      const slots = pSlots.map((sl) => ({ attack: sl.attack, defense: sl.defense }));
      const lastMove = findLastMove(view.log);
      let t0 = 0;
      if (lastMove && lastMove.key === 'defend') {
        // The final defend never rendered — play it first.
        const openIdx = slots.findIndex((sl) => !sl.defense);
        if (openIdx !== -1) {
          const card = lastMove.params.card;
          slots[openIdx].defense = card;
          steps.push({ at: 0, fn: () => flyToSlot(prev.defender, card, openIdx, slots.length, 'defense') });
          t0 = Math.round(ANIM_MS * 0.85);
        }
      }
      const defSeat = prev.defender;
      let i = 0;
      slots.forEach((sl) => {
        const at = t0 + i * stag;
        if (sl.defense) {
          const pair = sl;
          steps.push({
            at,
            fn: () => {
              flyToDiscard(pair.attack);
              flyToDiscard(pair.defense);
            },
          });
        } else if (defSeat === view.you) {
          const card = sl.attack;
          steps.push({
            at,
            fn: () => {
              const el = els.get(card);
              if (el) {
                stripStateClasses(el);
                const a = anchors();
                place(el, handCenter(a, gscale()));
              }
            },
          });
        } else {
          const card = sl.attack;
          steps.push({ at, fn: () => flyToFan(defSeat, card) });
        }
        i++;
      });
      tEnd = t0 + Math.max(0, i - 1) * stag + ANIM_MS;
    }
    return tEnd;
  }

  function choreoRefill(prev, view, t0, steps) {
    const me = view.you;
    const n = view.players.length;
    const order = [];
    for (let k = 0; k < n; k++) order.push((prev.attacker + k) % n);

    const lastTake = findLastKey(view.log, 'take');
    const picked = new Set(
      lastTake && lastTake.params.player === me ? lastTake.params.cards : []
    );
    const prevHand = new Set(prev.hand);
    const myNew = view.hand.filter((c) => !prevHand.has(c) && !picked.has(c));

    const total = (view.drewLast || []).reduce((x, y) => x + y, 0);
    if (total === 0) return t0;
    const stag = Math.max(120, Math.round(ANIM_MS * 0.3));
    let t = t0;
    let gi = 0;
    let mi = 0;
    order.forEach((seat) => {
      const cnt = view.drewLast[seat] || 0;
      for (let j = 0; j < cnt; j++) {
        const isLast = gi === total - 1;
        const trumpNow = isLast && view.trumpPicked && !prev.trumpPicked;
        const cardId = seat === me ? myNew[mi++] || null : null;
        if (trumpNow) {
          steps.push({ at: t, fn: () => flyTrumpTo(seat) });
        } else {
          steps.push({ at: t, fn: () => flyDraw(seat, cardId) });
        }
        t += stag;
        gi++;
      }
    });
    return t - stag + ANIM_MS;
  }

  // ── Sync: turn one server view into a timeline of moves + settle ──
  function syncScene(view, quick) {
    clearSceneTimers();
    const prev = sceneView;
    sceneView = view;
    showScreen('screen-game');

    // A remote preview is only valid for the exact actor/phase it was sent
    // for. Once the game moves past that (resolved, new attacker, new
    // defender), any leftover preview data is stale and must not resurface
    // if that same seat happens to attack/defend again later.
    if (remotePreview) {
      const stillRelevant =
        (remotePreview.type === 'attack' && view.phase === 'attack' && view.attacker === remotePreview.seat) ||
        (remotePreview.type === 'defense' && view.phase === 'defense' && view.defender === remotePreview.seat);
      if (!stillRelevant) remotePreview = null;
    }

    const steps = [];
    let tEnd = 0;
    let settleInstant = false;

    const isNewGame =
      !prev ||
      prev.players.length !== view.players.length ||
      prev.you !== view.you ||
      view.talonCount > prev.talonCount;

    if (isNewGame) {
      resetScene();
      const pristine =
        view.discardCount === 0 &&
        view.table.slots.length === 0 &&
        view.hand.length === 5 &&
        view.players.every((p) => p.finished || p.count === 5);
      renderOpponentPanels(view);
      renderHud(view);
      if (pristine && !quick) {
        tEnd = choreoDeal(view, steps);
      } else {
        settleInstant = true;
      }
    } else if (!quick) {
      tEnd = choreoExchange(prev, view, steps);
      if (view.trumpCard !== prev.trumpCard) {
        // swap7: the trump VII goes under the talon, the old trump comes out.
        const entry = findLastKey(view.log, 'swap7');
        const seat = entry ? entry.params.player : view.attacker;
        const oldTrump = prev.trumpCard;
        const at = tEnd;
        steps.push({
          at,
          fn: () => {
            const el = knownEl(view.trumpCard, seat);
            stripStateClasses(el);
            const a = anchors();
            const s = gscale();
            place(el, trumpPos(a, s));
            if (seat === view.you) {
              const oel = els.get(oldTrump);
              if (oel) place(oel, handCenter(a, s));
            } else {
              flyToFan(seat, oldTrump);
            }
          },
        });
        tEnd = at + ANIM_MS;
      }
      if (view.talonCount < prev.talonCount) {
        tEnd = choreoRefill(prev, view, tEnd, steps);
      }
    }

    steps.push({ at: tEnd, fn: () => settle(view, settleInstant) });
    steps.forEach((st) => {
      if (st.at <= 0) st.fn();
      else timers.push(setTimeout(st.fn, st.at));
    });
    return tEnd + 100;
  }

  // ── View queue (server can burst views during bot streaks) ───────
  let animQueue = [];
  let animTimer = null;
  socket.on('game', (data) => {
    animQueue.push(data.view);
    if (animQueue.length === 1) dequeueViews();
  });
  function dequeueViews() {
    if (animQueue.length === 0) return;
    clearTimeout(animTimer);
    // If we're falling behind the server, fast-forward: settle-only renders
    // still animate (transform transitions) but skip the step-by-step timing.
    const quick = animQueue.length >= 3;
    const view = animQueue[0];
    let dur = 0;
    try {
      dur = syncScene(view, quick);
    } catch (err) {
      // A rendering hiccup must never wedge the queue — recover to the
      // authoritative state and keep consuming views.
      console.error('render error', err);
      try {
        sceneView = view;
        settle(view, true);
      } catch (_) {
        /* state will heal on the next view */
      }
    }
    animTimer = setTimeout(() => {
      animQueue.shift();
      dequeueViews();
    }, quick ? Math.min(dur, 350) : dur + 60);
  }

  // ── Interactions (pointer-based: works for mouse and touch) ──────
  let drag = null;
  const layerEl = $('card-layer');

  layerEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.pcard');
    if (!el || !sceneView || sceneView.phase === 'over' || !sceneView.yourTurn) return;
    const kind = el.getAttribute('data-kind');
    const card = el.getAttribute('data-card');
    if (!card) return;
    if (kind !== 'hand' && kind !== 'staged' && kind !== 'attack' && kind !== 'pending-def' && kind !== 'trump') return;
    if ((kind === 'attack' || kind === 'pending-def') && sceneView.phase !== 'defense') return;
    if (kind === 'trump' && !el.classList.contains('clickable')) return;
    drag = {
      el,
      card,
      kind,
      slot: el.getAttribute('data-slot'),
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignored */
    }
    e.preventDefault();
  });

  layerEl.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && dx * dx + dy * dy < 64) return;
    drag.moved = true;
    drag.el.classList.add('no-anim', 'dragging');
    const L = layerEl.getBoundingClientRect();
    const s = gscale();
    drag.el.style.zIndex = String(Z.drag);
    drag.el.style.transform =
      'translate(' + (e.clientX - L.left - CW / 2) + 'px, ' + (e.clientY - L.top - CH / 2) + 'px)' +
      ' rotate(0deg) scale(' + s + ')';
    updateDropHints(e);
  });

  function endDrag(d) {
    d.el.classList.remove('dragging');
    requestAnimationFrame(() => d.el.classList.remove('no-anim'));
    clearDropHints();
  }

  layerEl.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    endDrag(d);
    if (!d.moved) handleClick(d);
    else handleDrop(d, e);
  });
  layerEl.addEventListener('pointercancel', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    endDrag(d);
    if (sceneView) settle(sceneView, false);
  });

  function updateDropHints(e) {
    if (!drag || !sceneView) return;
    const a = anchors();
    const L = layerEl.getBoundingClientRect();
    const py = e.clientY - L.top;
    if (drag.kind === 'hand' && sceneView.phase === 'attack') {
      $('slots-area').classList.toggle('drop-hint', py < a.hand.y - 10);
    }
  }
  function clearDropHints() {
    $('slots-area').classList.remove('drop-hint');
  }

  // Broadcast my own current staging/placement so opponents can watch it
  // happen live, instead of only seeing the final confirmed result. Purely
  // cosmetic on the receiving end — never authoritative.
  function emitAttackPreview() {
    if (!sceneView || !(sceneView.yourTurn && sceneView.phase === 'attack')) return;
    socket.emit('preview', { type: 'attack', cards: [...staged] });
  }
  function emitDefensePreview() {
    if (!sceneView || !(sceneView.yourTurn && sceneView.phase === 'defense')) return;
    socket.emit('preview', {
      type: 'defense',
      slots: [...pendingDef.entries()].map(([slot, card]) => ({ slot, card })),
    });
  }

  // Stage/unstage a hand card for an attack (unconfirmed — Send submits it).
  function stageCard(card) {
    staged.add(card);
    settle(sceneView, false);
    emitAttackPreview();
  }
  function unstageCard(card) {
    staged.delete(card);
    settle(sceneView, false);
    emitAttackPreview();
  }

  // Place a hand card on a slot locally (unconfirmed — Beat submits it).
  function assignDefense(slot, card) {
    pendingDef.set(slot, card);
    selectedDef = null;
    settle(sceneView, false);
    emitDefensePreview();
  }
  function unassignDefense(slot) {
    pendingDef.delete(slot);
    settle(sceneView, false);
    emitDefensePreview();
  }

  function handleClick(d) {
    const view = sceneView;
    if (!view) return;
    if (d.kind === 'trump') {
      if (view.legal.some((m) => m.type === 'swap7')) {
        socket.emit('move', { move: { type: 'swap7' } });
      }
    } else if (d.kind === 'hand' && view.phase === 'attack') {
      stageCard(d.card);
    } else if (d.kind === 'staged') {
      unstageCard(d.card);
    } else if (d.kind === 'pending-def') {
      unassignDefense(Number(d.slot));
    } else if (d.kind === 'hand' && view.phase === 'defense') {
      const moves = view.legal.filter(
        (m) =>
          m.type === 'defend' &&
          m.card === d.card &&
          !pendingDef.has(m.slot) &&
          view.table.slots[m.slot] &&
          view.table.slots[m.slot].defense == null
      );
      if (moves.length === 0) return toast(t(lang, 'err_does_not_beat'));
      if (moves.length === 1) return assignDefense(moves[0].slot, d.card);
      selectedDef = selectedDef === d.card ? null : d.card;
      settle(view, false);
    } else if (d.kind === 'attack' && view.phase === 'defense') {
      const slotIdx = Number(d.slot);
      if (!view.table.slots[slotIdx] || view.table.slots[slotIdx].defense != null) return;
      if (selectedDef) {
        const mv = view.legal.find(
          (m) => m.type === 'defend' && m.card === selectedDef && m.slot === slotIdx
        );
        const card = selectedDef;
        selectedDef = null;
        if (mv) return assignDefense(slotIdx, card);
        settle(view, false);
        return toast(t(lang, 'err_does_not_beat'));
      }
      if (pendingDef.has(slotIdx)) return unassignDefense(slotIdx);
    }
  }

  function handleDrop(d, e) {
    const view = sceneView;
    if (!view) return;
    const a = anchors();
    const s = gscale();
    const L = layerEl.getBoundingClientRect();
    const px = e.clientX - L.left;
    const py = e.clientY - L.top;
    const aboveHand = py < a.hand.y - 10;

    if (d.kind === 'hand' && view.phase === 'attack') {
      if (aboveHand) stageCard(d.card);
      else settle(view, false);
      return;
    }
    if (d.kind === 'staged') {
      if (!aboveHand) unstageCard(d.card);
      else settle(view, false);
      return;
    }
    if (d.kind === 'hand' && view.phase === 'defense') {
      const target = nearestOpenSlot(view, a, s, px, py);
      if (target != null) {
        const mv = view.legal.find(
          (m) => m.type === 'defend' && m.card === d.card && m.slot === target
        );
        if (mv) return assignDefense(target, d.card);
        toast(t(lang, 'err_does_not_beat'));
      }
      settle(view, false);
      return;
    }
    if (d.kind === 'pending-def') {
      const oldSlot = Number(d.slot);
      if (!aboveHand) return unassignDefense(oldSlot);
      const target = nearestOpenSlot(view, a, s, px, py);
      if (target != null && target !== oldSlot) {
        const mv = view.legal.find(
          (m) => m.type === 'defend' && m.card === d.card && m.slot === target
        );
        if (mv) {
          pendingDef.delete(oldSlot);
          return assignDefense(target, d.card);
        }
        toast(t(lang, 'err_does_not_beat'));
      }
      settle(view, false);
      return;
    }
    settle(view, false);
  }

  // Nearest slot (by its attack-card position) that is still open on the
  // server, within grabbing distance of the drop point.
  function nearestOpenSlot(view, a, s, px, py) {
    const n = view.table.slots.length;
    let best = null;
    view.table.slots.forEach((slot, i) => {
      if (slot.defense != null) return;
      const p = slotPos(a, s, i, n, 'attack');
      const dist = Math.hypot(p.x - px, p.y - py);
      if (dist < CW * s * 1.2 && (!best || dist < best.dist)) best = { i, dist };
    });
    return best ? best.i : null;
  }

  // ── Game actions ─────────────────────────────────────────────────
  $('btn-attack').onclick = () => {
    if (!sceneView) return;
    const selection = [...staged];
    const legalMatch = sceneView.legal.find((m) => m.type === 'attack' && sameSet(m.cards, selection));
    if (!legalMatch) return toast(t(lang, 'err_bad_set'));
    socket.emit('move', { move: { type: 'attack', cards: legalMatch.cards } });
  };
  // Confirm the whole defense at once: submit each placed card, then pick
  // up everything left uncovered. (A full beat resolves on its own.)
  //
  // The server applies (and broadcasts a view for) each submitted move one
  // at a time, so for a brief window some of these cards are "sent but not
  // yet reflected" in the views coming back. pendingDef is deliberately NOT
  // cleared here — clearing it early made settle() misclassify those
  // in-flight cards as ordinary hand cards (since the server's own hand
  // array still listed them) and fly them back before snapping them to
  // discard once confirmed. The per-view pruning in settle() already
  // removes each entry the moment its own confirmation arrives, and clears
  // the rest in one go once the exchange resolves — so it cleans up exactly
  // in step with the server instead of jumping ahead of it.
  $('btn-beat').onclick = () => {
    const view = sceneView;
    if (!view || !(view.yourTurn && view.phase === 'defense')) return;
    const entries = [...pendingDef.entries()].sort((x, y) => x[0] - y[0]);
    const needTake = view.table.slots.some(
      (slot, i) => slot.defense == null && !pendingDef.has(i)
    );
    entries.forEach(([slot, card]) => {
      socket.emit('move', { move: { type: 'defend', slot, card } });
    });
    if (needTake) socket.emit('move', { move: { type: 'take' } });
    $('btn-beat').disabled = true; // re-enabled by the next render if still relevant
  };
  $('btn-swap7').onclick = () => socket.emit('move', { move: { type: 'swap7' } });
  $('btn-leave-game').onclick = () => {
    socket.emit('leaveRoom');
    $('overlay').classList.remove('show');
    leaveGameUi();
    showScreen('screen-menu');
  };
  $('btn-rematch').onclick = () => socket.emit('rematch');
  $('btn-menu').onclick = () => {
    socket.emit('leaveRoom');
    $('overlay').classList.remove('show');
    leaveGameUi();
    showScreen('screen-menu');
  };

  // Keep the scene glued to the window size — instant, no animation.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (sceneView && $('screen-game').classList.contains('active')) settle(sceneView, true);
    }, 120);
  });

  // ── Log + game over ──────────────────────────────────────────────
  function renderLog(view) {
    const ul = $('log-list');
    ul.innerHTML = '';
    const nameOf = (i) => (view.players[i] ? view.players[i].name : '?');
    view.log.forEach((e) => {
      const p = e.params || {};
      const cardStr = p.cards
        ? p.cards.map((c) => cardName(lang, c)).join(', ')
        : p.card
          ? cardName(lang, p.card)
          : '';
      const params = {
        p: p.player != null ? nameOf(p.player) : '',
        card: cardStr,
        trump: p.trump ? suitName(lang, p.trump) : '',
        rank: p.rank != null ? p.rank : '',
      };
      const li = document.createElement('li');
      li.textContent = t(lang, 'log_' + e.key, params);
      ul.appendChild(li);
    });
    ul.scrollTop = ul.scrollHeight;
  }

  function showOver(view) {
    const title = $('over-title');
    const detail = $('over-detail');
    if (view.loser == null) {
      title.textContent = t(lang, 'draw');
      detail.textContent = '';
    } else if (view.loser === view.you) {
      title.textContent = t(lang, 'youLose');
      detail.textContent = '';
    } else {
      title.textContent = t(lang, 'youWin');
      detail.textContent = t(lang, 'loserIs', { name: view.players[view.loser].name });
    }
    const ol = $('over-order');
    ol.innerHTML = '';
    view.finishedOrder.forEach((idx) => {
      const li = document.createElement('li');
      li.textContent = view.players[idx].name;
      ol.appendChild(li);
    });
    if (view.loser != null) {
      const li = document.createElement('li');
      li.textContent = `${view.players[view.loser].name} — bürge 🙈`;
      ol.appendChild(li);
    }
    $('overlay').classList.add('show');
  }

  // ── Language + rules ─────────────────────────────────────────────
  qsa('.lang').forEach((b) => {
    b.onclick = () => setLang(b.getAttribute('data-lang'));
  });
  $('btn-rules').onclick = () => $('rules-modal').classList.add('show');
  $('btn-rules-close').onclick = () => $('rules-modal').classList.remove('show');

  function buildRules() {
    const hu = `
      <h4>Cél</h4>
      <ul><li>Szabadulj meg a lapjaidtól! Aki utoljára marad lappal, az lesz a <b>bürge</b>.</li></ul>
      <h4>Kártya</h4>
      <ul><li>32 lapos magyar kártya. Színek: Tök, Makk, Zöld, Piros.</li>
      <li>Sorrend (gyenge→erős): VII, VIII, IX, X, Alsó, Felső, Király, Ász.</li></ul>
      <h4>Menet</h4>
      <ul>
        <li>Mindenki 5 lapot kap. A felfordított lap színe az <b>adu</b>; ez a húzópakli aljára kerül.</li>
        <li>Támadáshoz húzd ki a lapo(ka)t az asztalra: egyet, egy <b>párost</b> (két azonos értékű lap,
        bármilyen színben — pl. piros ász + zöld ász) + 1 tetszőleges kísérő lapot, vagy két párost + 1
        kísérőt — legfeljebb annyit, amennyi lap éppen a védőnél van — majd kattints: Küldés.</li>
        <li>Védéskor tedd a lapjaid az ütendő lapokra, majd nyomd meg az Ütés gombot — amire nem
        tettél lapot, azt felveszed. Az ütés sosem kötelező, és a gomb megnyomásáig bármit átrendezhetsz.</li>
        <li>Amint minden kirakott lap el van intézve (leütve vagy felvéve), a kör automatikusan lezárul:
        a leütött lapok a dobóba kerülnek, a felvett lapok a kezedbe. Ha mindent
        leütöttél, te leszel a következő támadó; ha felvettél valamit, kimaradsz, a következő játékos támad.</li>
        <li>Minden kör után 5-re töltötök a pakliból, amíg van lap.</li>
        <li>Az adu VII a saját köröd elején elcserélhető a felfordított adura — kivéve, ha már csak az az
        egy lap maradt a pakliban.</li>
      </ul>
      <p class="credit">Lapképek: szám- és figurás lapok — SZERVÁC Attila fotója (<a href="https://commons.wikimedia.org/wiki/File:Original-Hungarian-Tell-set.jpg" target="_blank" rel="noopener">Wikimedia Commons</a>,
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>, vágva, gyártói jelzés eltávolítva); ászok —
      Sürch és Neumayer 1860-as metszete (<a href="https://commons.wikimedia.org/wiki/File:Piatnik_%C3%A1szok.jpg" target="_blank" rel="noopener">Wikimedia Commons</a>, közkincs).</p>`;
    const en = `
      <h4>Goal</h4>
      <ul><li>Get rid of your cards! Whoever is left holding cards is the <b>bürge</b>.</li></ul>
      <h4>Cards</h4>
      <ul><li>32-card Hungarian deck. Suits: Bells, Acorns, Leaves, Hearts.</li>
      <li>Order (weak→strong): VII, VIII, IX, X, Under, Over, King, Ace.</li></ul>
      <h4>Play</h4>
      <ul>
        <li>Everyone gets 5 cards. The flipped card's suit is <b>trump</b>; it goes to the bottom of the draw pile.</li>
        <li>To attack, drag card(s) onto the table: one, a <b>pair</b> (two cards of the same rank, any suits
        — e.g. red ace + green ace) + 1 free extra card, or two pairs + 1 extra — capped at the defender's
        current hand size — then click Send.</li>
        <li>To defend, place hand cards onto the attacks you want to beat, then press Beat — everything
        left uncovered is picked up. Beating is never mandatory, and you can rearrange freely until you confirm.</li>
        <li>Once every card on the table has been dealt with (beaten or picked up), the round resolves
        automatically: beaten cards go to discard, picked-up cards go to your hand. If you beat everything,
        you lead next; if you picked anything up, you're skipped and the next player leads.</li>
        <li>After each round refill to 5 while the pile lasts.</li>
        <li>The trump VII may be swapped for the face-up trump at the start of your turn — except once
        that's the only card left in the draw pile.</li>
      </ul>
      <p class="credit">Card photos: number and court cards — SZERVÁC Attila (<a href="https://commons.wikimedia.org/wiki/File:Original-Hungarian-Tell-set.jpg" target="_blank" rel="noopener">Wikimedia Commons</a>,
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>, cropped, manufacturer mark removed); aces —
      Sürch &amp; Neumayer's 1860 engraving (<a href="https://commons.wikimedia.org/wiki/File:Piatnik_%C3%A1szok.jpg" target="_blank" rel="noopener">Wikimedia Commons</a>, public domain).</p>`;
    $('rules-body').innerHTML = lang === 'hu' ? hu : en;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    }[c]));
  }

  // ── Socket events ────────────────────────────────────────────────
  socket.on('lobby', renderLobby);
  // Another player's tentative (unconfirmed) attack staging or defense
  // placement, relayed live. Re-validated against the CURRENT authoritative
  // view before accepting — a stale or mismatched event is simply dropped.
  socket.on('preview', (d) => {
    if (!sceneView || !d) return;
    if (d.type === 'attack' && !(sceneView.phase === 'attack' && sceneView.attacker === d.seat)) return;
    if (d.type === 'defense' && !(sceneView.phase === 'defense' && sceneView.defender === d.seat)) return;
    remotePreview = d;
    settle(sceneView, false);
  });
  socket.on('errorMsg', (code) => {
    showSearch(false);
    toast(t(lang, 'err_' + code) || t(lang, 'err_generic'));
  });
  // Matchmaking: the searching modal stays up until we're matched, cancel,
  // or the connection drops.
  socket.on('matchSearching', () => showSearch(true));
  socket.on('matched', () => showSearch(false));
  socket.on('matchCancelled', () => showSearch(false));
  socket.on('matchCount', (data = {}) => renderMatchCount(data.count));
  // The code belongs to a Royal Game of Ur room — hop over there with the
  // code prefilled so the join completes automatically.
  socket.on('wrongGame', ({ code } = {}) => {
    toast(t(lang, 'wrongGameUr'));
    setTimeout(() => {
      window.location.href = '/ur/?join=' + encodeURIComponent(code || '');
    }, 1500);
  });
  socket.on('leftRoom', () => {
    leaveGameUi();
    showScreen('screen-menu');
  });
  socket.on('joined', () => {});
  socket.on('resumed', () => {
    toast(t(lang, 'reconnected'));
  });
  let sessionReplaced = false;
  socket.on('sessionReplaced', () => {
    sessionReplaced = true;
    showSearch(false);
    toast(t(lang, 'sessionReplaced'));
  });
  // Our unfinished room lives in the other game — go there and resume.
  socket.on('resumeElsewhere', ({ game } = {}) => {
    if (game === 'ur') window.location.href = '/ur/';
  });

  // A ?join=CODE in the URL (arriving from the other game's redirect) joins
  // that room as soon as the socket is up; otherwise ask the server whether
  // this browser has a seat to come back to (closed tab, lost connection…).
  let pendingJoin = null;
  const joinParam = new URLSearchParams(window.location.search).get('join');
  if (joinParam) {
    pendingJoin = joinParam.trim().toUpperCase();
    $('code-input').value = pendingJoin;
    history.replaceState(null, '', window.location.pathname);
  }
  socket.on('connect', () => {
    if (pendingJoin) {
      const code = pendingJoin;
      pendingJoin = null;
      socket.emit('joinRoom', { code, name: myName(), clientId: clientId() });
      return;
    }
    socket.emit('resume', { clientId: clientId() });
  });
  socket.on('disconnect', () => {
    showSearch(false);
    if (sessionReplaced) return;
    toast(t(lang, 'disconnected'));
  });

  // ── Init ─────────────────────────────────────────────────────────
  $('name-input').value = localStorage.getItem('burge_name') || '';
  applyAnimSpeed(Number(localStorage.getItem('burge_anim_ms')) || 900);
  $('anim-speed').addEventListener('change', (e) => applyAnimSpeed(Number(e.target.value)));
  const bs = $('bot-speed');
  if (bs) {
    bs.value = String(myBotDelay());
    bs.addEventListener('change', (e) => localStorage.setItem('burge_bot_ms', e.target.value));
  }
  applyStaticI18n();
  buildRules();
})();
