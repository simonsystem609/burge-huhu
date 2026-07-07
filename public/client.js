/* Bürge / Hühü — client. Browser globals: I18N, Cards, io */
(function () {
  'use strict';

  const socket = io({ reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 4000 });
  const { t, suitName, cardName } = window.I18N;
  const { cardHTML, cardBackHTML } = window.Cards;

  let lang = localStorage.getItem('burge_lang') || 'hu';
  let lastLobby = null;
  let lastView = null;
  let lastSid = null; // last socket id we knew, for rejoin matching
  let animQueue = [];
  let animTimer = null;
  let tableLocked = false;

  // Flying-card animation duration — one shared value for every kind of card
  // move (attack, defend, discard, pickup), for every player. Adjustable from
  // the menu; applied as a CSS custom property so JS timing and the CSS
  // transition never drift apart.
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
  function stagger(i) {
    return i * Math.round(ANIM_MS * 0.45);
  }
  let selectedAttack = new Set(); // cards dragged/tapped out for the attack combo
  let markedPickup = new Set(); // table slot indices the user has dragged to themselves to give up on
  // Rect of a hand card the instant it's played, keyed by card id — the table
  // never gets a chance to render the move that completes a full defense, so
  // its animation has to originate from the hand instead of the table.
  let justPlayedOrigins = {};

  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

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
  }

  function setLang(next) {
    lang = next;
    localStorage.setItem('burge_lang', lang);
    applyStaticI18n();
    if ($('screen-lobby').classList.contains('active') && lastLobby) renderLobby(lastLobby);
    if ($('screen-game').classList.contains('active') && lastView) renderGame(lastView, { animate: false });
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

  function myBotDelay() {
    return Number(localStorage.getItem('burge_bot_ms')) || 800;
  }

  $('btn-single').onclick = () =>
    socket.emit('singleplayer', {
      name: myName(),
      lang,
      bots: Number($('bot-count').value),
      botDelayMs: myBotDelay(),
    });
  $('btn-create').onclick = () => socket.emit('createRoom', { name: myName(), lang, botDelayMs: myBotDelay() });
  $('btn-join').onclick = () => {
    const code = ($('code-input').value || '').trim().toUpperCase();
    if (code.length < 4) return toast(t(lang, 'err_no_room'));
    socket.emit('joinRoom', { code, name: myName() });
  };
  $('code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

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
      if (s.isBot) badges += `<span class="badge bot">BOT</span>`;
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

  // ── Game rendering ───────────────────────────────────────────────
  function actorIndex(view) {
    return view.phase === 'defense' ? view.defender : view.attacker;
  }

  function captureTableCardRects() {
    const rects = { ...justPlayedOrigins };
    qsa('#table-cards [data-card]').forEach((el) => {
      rects[el.getAttribute('data-card')] = el.getBoundingClientRect();
    });
    justPlayedOrigins = {};
    return rects;
  }

  // `land`: 'pile' (default) flies to the pile center, then shrinks away;
  // 'place' arrives at full size/opacity, landing flat as a table card.
  function spawnFlyingCard(cardId, fromRect, toRect, delay, land) {
    land = land || 'pile';
    const wrap = document.createElement('div');
    wrap.innerHTML = cardId ? cardHTML(cardId, {}) : cardBackHTML({});
    const el = wrap.firstElementChild;
    el.classList.add('flying-card');
    el.style.left = fromRect.left + 'px';
    el.style.top = fromRect.top + 'px';
    el.style.width = fromRect.width + 'px';
    el.style.height = fromRect.height + 'px';
    document.body.appendChild(el);
    void el.offsetWidth;
    setTimeout(() => {
      if (land === 'place') {
        el.style.left = toRect.left + 'px';
        el.style.top = toRect.top + 'px';
        el.style.width = toRect.width + 'px';
        el.style.height = toRect.height + 'px';
        el.style.transform = 'none';
        el.style.opacity = '1';
      } else {
        const destX = toRect.left + toRect.width / 2 - fromRect.width / 2;
        const destY = toRect.top + toRect.height / 2 - fromRect.height / 2;
        el.style.left = destX + 'px';
        el.style.top = destY + 'px';
        el.style.opacity = '1';
        setTimeout(() => {
          el.style.transform = `scale(0.45) rotate(${(Math.random() * 30 - 15).toFixed(1)}deg)`;
          el.style.opacity = '0.1';
        }, ANIM_MS + 300);
      }
    }, delay);
    setTimeout(() => el.remove(), delay + ANIM_MS * 2 + 600);
  }

  function pointRect(cx, cy, w, h) {
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
  }

  // A small card-sized rect centered on a player's hand (me) or fan (an
  // opponent/bot) — used as the generic origin/destination for cards we
  // don't have a specific real element for (an opponent's hand is hidden).
  function actorPileRect(seatIndex, view) {
    if (seatIndex === view.you) {
      const el = $('my-hand');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return pointRect(r.left + r.width / 2, r.top + r.height / 2, 84, 124);
    }
    const el = document.querySelector(`#opponents .opp[data-seat="${seatIndex}"] .fan`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return pointRect(r.left + r.width / 2, r.top + r.height / 2, 58, 84);
  }

  // Each previous slot is beaten (both cards -> discard) or was left
  // undefended (its attack card -> the acting player's hand). `extraCard`,
  // if any, is the last defend that completed a full beat with no pickups —
  // it never got a chance to render on the table, so it always -> discard.
  function playResolutionAnimation(prevSlots, extraCard, actingPlayer, oldRects, newView) {
    const discardEl = $('discard-card') || document.querySelector('.discard-pile');
    const discardRect = discardEl ? discardEl.getBoundingClientRect() : null;
    const hasPickup = prevSlots.some((s) => s.defense == null);
    let handRect = null;
    if (hasPickup) {
      const handEl =
        actingPlayer === newView.you
          ? $('my-hand')
          : document.querySelector(`#opponents .opp[data-seat="${actingPlayer}"]`);
      handRect = handEl ? handEl.getBoundingClientRect() : null;
    }

    let i = 0;
    prevSlots.forEach((slot) => {
      if (slot.defense != null) {
        if (!discardRect) return;
        [slot.attack, slot.defense].forEach((cardId) => {
          const fromRect = oldRects[cardId];
          if (fromRect) spawnFlyingCard(cardId, fromRect, discardRect, stagger(i++));
        });
      } else if (handRect) {
        const fromRect = oldRects[slot.attack];
        if (fromRect) spawnFlyingCard(slot.attack, fromRect, handRect, stagger(i++));
      }
    });
    if (extraCard && discardRect) {
      const fromRect = oldRects[extraCard];
      if (fromRect) spawnFlyingCard(extraCard, fromRect, discardRect, stagger(i++));
    }
  }

  // A fresh attack just appeared (0 -> N table slots): fly each attack card
  // from the attacker's staged cards (if it was me) or their fan (a bot/
  // opponent) onto its new table slot.
  function playAttackAnimation(slots, attacker, oldStagingRects, view) {
    const fallbackRect = actorPileRect(attacker, view);
    let i = 0;
    slots.forEach((slot) => {
      const cardId = slot.attack;
      const toEl = document.querySelector(`#table-cards .slot > [data-card="${CSS.escape(cardId)}"]`);
      if (!toEl) return;
      const toRect = toEl.getBoundingClientRect();
      const fromRect = (oldStagingRects && oldStagingRects[cardId]) || fallbackRect;
      if (fromRect) spawnFlyingCard(cardId, fromRect, toRect, stagger(i++), 'place');
    });
  }

  // A single slot just got its defense card filled in (not the last one —
  // that case resolves the whole exchange instead, see playResolutionAnimation).
  function playDefendAnimation(slotIndex, cardId, defender, view) {
    const toEl = document.querySelector(
      `#table-cards .slot[data-slot="${slotIndex}"] .defense [data-card="${CSS.escape(cardId)}"]`
    );
    if (!toEl) return;
    const toRect = toEl.getBoundingClientRect();
    const fromRect = justPlayedOrigins[cardId] || actorPileRect(defender, view);
    delete justPlayedOrigins[cardId];
    if (fromRect) spawnFlyingCard(cardId, fromRect, toRect, 0, 'place');
  }

  // Cards drawn from the talon during refill: fly from the talon pile to each
  // player's hand area, one by one, staggered across all players.
  function playRefillAnimation(drewLast, view) {
    const talonEl = $('talon-stack');
    if (!talonEl) return;
    const talonRect = talonEl.getBoundingClientRect();
    if (!talonRect) return;
    let staggerIdx = 0;
    for (let seat = 0; seat < drewLast.length; seat++) {
      const n = drewLast[seat];
      if (n <= 0) continue;
      const toRect = actorPileRect(seat, view);
      if (!toRect) continue;
      for (let j = 0; j < n; j++) {
        spawnFlyingCard(null, talonRect, toRect, stagger(staggerIdx++));
      }
    }
  }

  function renderGame(view, opts) {
    opts = opts || {};
    const animate = opts.animate !== false;
    const prevView = lastView;

    const prevSlots = prevView ? prevView.table.slots : [];

    let pendingAnim = null;
    if (animate && prevView) {
      if (prevSlots.length > 0 && view.table.slots.length === 0) {
        // A full exchange just resolved (beaten -> discard, undefended -> hand)
        // — for whichever player acted, human or bot.
        const last = view.log[view.log.length - 1];
        if (last && last.key === 'defend') {
          pendingAnim = {
            kind: 'resolve',
            prevSlots,
            extraCard: last.params.card,
            player: null,
            oldRects: captureTableCardRects(),
          };
        } else if (last && last.key === 'take') {
          pendingAnim = {
            kind: 'resolve',
            prevSlots,
            extraCard: null,
            player: last.params.player,
            oldRects: captureTableCardRects(),
          };
        }
      } else if (prevSlots.length === 0 && view.table.slots.length > 0) {
        // A fresh attack was just laid out.
        let oldStagingRects = null;
        if (view.attacker === view.you) {
          oldStagingRects = {};
          qsa('#attack-staging [data-card]').forEach((el) => {
            oldStagingRects[el.getAttribute('data-card')] = el.getBoundingClientRect();
          });
        }
        pendingAnim = { kind: 'attack', slots: view.table.slots, attacker: view.attacker, oldStagingRects };
      } else if (
        prevSlots.length === view.table.slots.length &&
        view.table.slots.length > 0 &&
        view.table.slots.some((s, i) => prevSlots[i] && prevSlots[i].defense == null && s.defense != null)
      ) {
        // One slot (not the last) just got its defense card filled in.
        const idx = view.table.slots.findIndex(
          (s, i) => prevSlots[i] && prevSlots[i].defense == null && s.defense != null
        );
        pendingAnim = { kind: 'defend', slotIndex: idx, card: view.table.slots[idx].defense, defender: view.defender };
      }
    }

    if (!(view.yourTurn && view.phase === 'attack')) selectedAttack.clear();
    if (!(view.yourTurn && view.phase === 'defense')) markedPickup.clear();

    lastView = view;
    showScreen('screen-game');

    if (!tableLocked) {
      const tableEl = document.querySelector('#screen-game .table');
      if (tableEl) {
        const r = tableEl.getBoundingClientRect();
        tableEl.style.width = r.width + 'px';
        tableEl.style.height = r.height + 'px';
        tableEl.style.flex = 'none';
        tableLocked = true;
      }
    }

    // Opponents — update in place, don't rebuild.
    let oppEls = {};
    qsa('#opponents .opp[data-seat]').forEach((el) => {
      oppEls[Number(el.getAttribute('data-seat'))] = el;
    });
    const oppFrag = document.createDocumentFragment();
    const n = view.players.length;
    for (let k = 1; k < n; k++) {
      const seat = (view.you + k) % n;
      const p = view.players[seat];
      const existing = oppEls[seat];
      const cls =
        'opp' +
        (p.isAttacker ? ' attacker' : '') +
        (p.isDefender ? ' defender' : '') +
        (p.finished ? ' finished' : '');
      const fan = Array.from({ length: Math.min(p.count, 6) })
        .map(() => cardBackHTML({ small: true }))
        .join('') || '—';
      const meta = p.finished
        ? `#${p.finishRank}`
        : `${p.count} 🂠${p.isBot ? ' · BOT' : ''}`;
      if (existing) {
        existing.className = cls;
        existing.querySelector('.fan').innerHTML = fan;
        existing.querySelector('.opp-name').textContent = p.name;
        existing.querySelector('.opp-meta').textContent = meta;
        oppFrag.appendChild(existing);
        delete oppEls[seat];
      } else {
        const div = document.createElement('div');
        div.className = cls;
        div.setAttribute('data-seat', seat);
        div.innerHTML =
          `<div class="fan">${fan}</div>` +
          `<div class="opp-name">${escapeHtml(p.name)}</div>` +
          `<div class="opp-meta">${meta}</div>`;
        oppFrag.appendChild(div);
      }
    }
    $('opponents').replaceChildren(oppFrag);

    // Trump + talon (combined pile) + discard.
    $('trump-card').innerHTML = cardHTML(view.trumpCard, { small: true });
    $('trump-card').classList.toggle('picked', view.trumpPicked);
    $('trump-picked-label').classList.toggle('show', view.trumpPicked);
    $('trump-suit-name').textContent = suitName(lang, view.trumpSuit);
    $('talon-card').innerHTML = cardBackHTML({ small: true });
    $('talon-card').style.visibility = view.talonCount > 0 ? '' : 'hidden';
    $('talon-count').textContent = view.talonCount;
    $('discard-card').innerHTML = cardBackHTML({ small: true });
    $('discard-card').style.visibility = view.discardCount > 0 ? '' : 'hidden';
    $('discard-count').textContent = view.discardCount;

    const inAttackPhase = view.yourTurn && view.phase === 'attack';
    const inDefensePhase = view.yourTurn && view.phase === 'defense';

    // Attack staging area — cards dragged/tapped out of the hand, awaiting Send.
    const stagingFrag = document.createDocumentFragment();
    if (inAttackPhase) {
      [...selectedAttack].forEach((card) => {
        const wrap = document.createElement('div');
        wrap.innerHTML = cardHTML(card, {});
        stagingFrag.appendChild(wrap.firstElementChild);
      });
    }
    $('attack-staging').replaceChildren(stagingFrag);

    // Table (one or more attack/defense slots).
    const tcFrag = document.createDocumentFragment();
    view.table.slots.forEach((slot, i) => {
      const undefended = slot.defense == null;
      const marked = markedPickup.has(i);
      const targetable = inDefensePhase && undefended && !marked;
      const div = document.createElement('div');
      div.className =
        'slot' +
        (targetable ? ' targetable' : '') +
        (marked ? ' marked-pickup' : '');
      div.setAttribute('data-slot', i);
      let html = cardHTML(slot.attack, {});
      if (slot.defense) html += `<div class="defense">${cardHTML(slot.defense)}</div>`;
      if (marked) html += `<div class="pickup-tag">${t(lang, 'pickupTag')}</div>`;
      div.innerHTML = html;
      tcFrag.appendChild(div);
    });
    $('table-cards').replaceChildren(tcFrag);

    // Turn banner.
    const banner = $('turn-banner');
    banner.classList.remove('you');
    if (view.yourTurn) {
      banner.classList.add('you');
      banner.textContent =
        view.phase === 'defense' ? t(lang, 'defendPrompt') : t(lang, 'attackPrompt');
    } else {
      const who = view.players[actorIndex(view)];
      banner.textContent = t(lang, 'waitingFor', { name: who ? who.name : '' });
    }

    // My hand — atomic replace, no innerHTML wipe.
    const hand = $('my-hand');
    const handFrag = document.createDocumentFragment();
    view.hand.forEach((card) => {
      if (inAttackPhase && selectedAttack.has(card)) return;
      let draggableCard = false;
      let disabled = false;
      if (inAttackPhase) {
        draggableCard = true;
      } else if (inDefensePhase) {
        const canBeatSomething = view.legal.some((m) => m.type === 'defend' && m.card === card);
        draggableCard = canBeatSomething;
        disabled = !canBeatSomething;
      } else {
        disabled = true;
      }
      const wrap = document.createElement('div');
      wrap.innerHTML = cardHTML(card, { selectable: draggableCard, disabled });
      const cardEl = wrap.firstElementChild;
      if (inAttackPhase || (inDefensePhase && !disabled)) {
        cardEl.setAttribute('draggable', 'true');
      }
      handFrag.appendChild(cardEl);
    });
    hand.replaceChildren(handFrag);
    qsa('#table-cards .slot.targetable > .card').forEach((el) => el.setAttribute('draggable', 'true'));
    qsa('#attack-staging .card').forEach((el) => el.setAttribute('draggable', 'true'));

    // Action buttons.
    const canSwap = view.legal.some((m) => m.type === 'swap7');
    $('btn-swap7').style.display = canSwap ? '' : 'none';
    $('btn-attack').style.display = inAttackPhase ? '' : 'none';
    if (inAttackPhase) {
      const selection = [...selectedAttack];
      const legalNow = view.legal.some((m) => m.type === 'attack' && sameSet(m.cards, selection));
      $('btn-attack').disabled = !legalNow;
      $('btn-attack').textContent =
        t(lang, 'attackBtn') + (selection.length > 0 ? ` (${selection.length})` : '');
    }

    renderLog(view);

    if (view.phase === 'over') showOver(view);
    else $('overlay').classList.remove('show');

    let animTotal = 0;

    if (pendingAnim) {
      if (pendingAnim.kind === 'resolve') {
        playResolutionAnimation(
          pendingAnim.prevSlots,
          pendingAnim.extraCard,
          pendingAnim.player,
          pendingAnim.oldRects,
          view
        );
        const resolveCards = pendingAnim.prevSlots.length * 2 + 1;
        animTotal = stagger(resolveCards) + ANIM_MS + 150;
      } else if (pendingAnim.kind === 'attack') {
        playAttackAnimation(pendingAnim.slots, pendingAnim.attacker, pendingAnim.oldStagingRects, view);
        animTotal = stagger(pendingAnim.slots.length) + ANIM_MS + 150;
      } else if (pendingAnim.kind === 'defend') {
        playDefendAnimation(pendingAnim.slotIndex, pendingAnim.card, pendingAnim.defender, view);
        animTotal = ANIM_MS + 150;
      }
    }

    if (animate && prevView && view.drewLast && view.drewLast.some((n) => n > 0)) {
      const resolveSlots = prevView ? prevView.table.slots.length : 0;
      const resolveCards = resolveSlots * 2 + 1;
      const resolveDone = stagger(resolveCards) + ANIM_MS + 100;
      const totalDrew = view.drewLast.reduce((a, b) => a + b, 0);
      const refillDur = stagger(totalDrew) + ANIM_MS + 150;
      setTimeout(() => playRefillAnimation(view.drewLast, view), resolveDone);
      animTotal = Math.max(animTotal, resolveDone + refillDur);
    }

    // Auto-resolve: once every table slot has either been beaten (server-
    // confirmed) or marked for pickup (locally, via drag/tap), submit `take`
    // — it discards the beaten ones and hands over only what's left. No
    // pickup/submit button needed.
    if (inDefensePhase && view.table.slots.length > 0) {
      const allAccounted = view.table.slots.every((slot, i) => slot.defense != null || markedPickup.has(i));
      if (allAccounted) {
        markedPickup.clear();
        socket.emit('move', { move: { type: 'take' } });
      }
    }
    return animTotal;
  }

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

  // ── Drag and drop ────────────────────────────────────────────────
  // Native HTML5 drag-and-drop. `draggedData` is tracked directly (rather
  // than relying on dataTransfer.getData, which isn't readable during
  // dragover in most browsers) since everything happens within one page.
  let draggedData = null;
  let draggedEl = null;

  document.addEventListener('dragstart', (e) => {
    const handCard = e.target.closest('#my-hand .card[draggable="true"]');
    const stagedCard = e.target.closest('#attack-staging .card');
    const tableCard = e.target.closest('#table-cards .slot.targetable > .card');
    if (handCard) {
      draggedData = { from: 'hand', card: handCard.getAttribute('data-card') };
      draggedEl = handCard;
    } else if (stagedCard) {
      draggedData = { from: 'staging', card: stagedCard.getAttribute('data-card') };
      draggedEl = stagedCard;
    } else if (tableCard) {
      const slotEl = tableCard.closest('.slot');
      draggedData = {
        from: 'table',
        slot: Number(slotEl.getAttribute('data-slot')),
        card: tableCard.getAttribute('data-card'),
      };
      draggedEl = tableCard;
    } else {
      draggedData = null;
      draggedEl = null;
      return;
    }
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', draggedData.card);
    } catch (_) {
      /* ignored — draggedData is the real source of truth */
    }
  });
  document.addEventListener('dragend', () => {
    draggedData = null;
    draggedEl = null;
    qsa('.drag-over, .drag-over-stage, .drag-over-return').forEach((el) =>
      el.classList.remove('drag-over', 'drag-over-stage', 'drag-over-return')
    );
  });

  function submitDefend(slot, card) {
    const candidates = lastView.legal.filter((m) => m.type === 'defend' && m.card === card && m.slot === slot);
    if (candidates.length === 0) return toast(t(lang, 'err_does_not_beat'));
    markedPickup.delete(slot);
    if (draggedEl) justPlayedOrigins[card] = draggedEl.getBoundingClientRect();
    socket.emit('move', { move: candidates[0] });
  }

  // Drop hand card onto an attack slot -> beat it.
  const tableCardsEl = $('table-cards');
  tableCardsEl.addEventListener('dragover', (e) => {
    const slotEl = e.target.closest('.slot');
    if (!slotEl || !draggedData || draggedData.from !== 'hand' || !lastView) return;
    const i = Number(slotEl.getAttribute('data-slot'));
    if (lastView.table.slots[i].defense != null) return;
    e.preventDefault();
    slotEl.classList.add('drag-over');
  });
  tableCardsEl.addEventListener('dragleave', (e) => {
    const slotEl = e.target.closest('.slot');
    if (slotEl) slotEl.classList.remove('drag-over');
  });
  tableCardsEl.addEventListener('drop', (e) => {
    const slotEl = e.target.closest('.slot');
    if (!slotEl || !draggedData || draggedData.from !== 'hand') return;
    e.preventDefault();
    submitDefend(Number(slotEl.getAttribute('data-slot')), draggedData.card);
  });

  // Drop hand card onto the table area (attack phase) -> stage it.
  const tablePlayEl = $('table-play');
  tablePlayEl.addEventListener('dragover', (e) => {
    if (!draggedData || draggedData.from !== 'hand' || !lastView || lastView.phase !== 'attack') return;
    e.preventDefault();
    tablePlayEl.classList.add('drag-over-stage');
  });
  tablePlayEl.addEventListener('dragleave', () => tablePlayEl.classList.remove('drag-over-stage'));
  tablePlayEl.addEventListener('drop', (e) => {
    if (!draggedData || draggedData.from !== 'hand' || !lastView || lastView.phase !== 'attack') return;
    e.preventDefault();
    tablePlayEl.classList.remove('drag-over-stage');
    selectedAttack.add(draggedData.card);
    renderGame(lastView, { animate: false });
  });

  // Hand area: drop a staged card back -> unstage; drop a table attack card -> mark for pickup.
  // The drop target is the whole `.me` section (hand + action buttons), not
  // just the tight `#my-hand` box — a bigger, more forgiving target that
  // doesn't require dropping in the exact small area the cards occupy.
  const handEl = $('my-hand');
  const meEl = document.querySelector('.me');
  meEl.addEventListener('dragover', (e) => {
    if (!draggedData) return;
    if (draggedData.from === 'staging' || draggedData.from === 'table') {
      e.preventDefault();
      meEl.classList.add('drag-over-return');
    }
  });
  meEl.addEventListener('dragleave', (e) => {
    if (!meEl.contains(e.relatedTarget)) meEl.classList.remove('drag-over-return');
  });
  meEl.addEventListener('drop', (e) => {
    if (!draggedData) return;
    meEl.classList.remove('drag-over-return');
    if (draggedData.from === 'staging') {
      e.preventDefault();
      selectedAttack.delete(draggedData.card);
      renderGame(lastView, { animate: false });
    } else if (draggedData.from === 'table') {
      e.preventDefault();
      const i = draggedData.slot;
      if (lastView && lastView.table.slots[i] && lastView.table.slots[i].defense == null) {
        markedPickup.add(i);
        renderGame(lastView, { animate: false });
      }
    }
  });

  // ── Click fallbacks (also used on touch devices without drag support) ──
  handEl.addEventListener('click', (e) => {
    const el = e.target.closest('.card');
    if (!el || !lastView || !lastView.yourTurn) return;
    const card = el.getAttribute('data-card');
    if (lastView.phase === 'attack') {
      selectedAttack.add(card);
      renderGame(lastView, { animate: false });
    } else if (lastView.phase === 'defense') {
      const candidates = lastView.legal.filter((m) => m.type === 'defend' && m.card === card);
      if (candidates.length === 0) return toast(t(lang, 'err_does_not_beat'));
      draggedEl = el;
      submitDefend(candidates[0].slot, card);
      draggedEl = null;
    }
  });

  $('attack-staging').addEventListener('click', (e) => {
    const el = e.target.closest('.card');
    if (!el) return;
    selectedAttack.delete(el.getAttribute('data-card'));
    renderGame(lastView, { animate: false });
  });

  tableCardsEl.addEventListener('click', (e) => {
    const slotEl = e.target.closest('.slot');
    if (!slotEl || !lastView || !lastView.yourTurn || lastView.phase !== 'defense') return;
    const i = Number(slotEl.getAttribute('data-slot'));
    if (lastView.table.slots[i].defense != null) return;
    if (markedPickup.has(i)) markedPickup.delete(i);
    else markedPickup.add(i);
    renderGame(lastView, { animate: false });
  });

  // ── Game actions ─────────────────────────────────────────────────
  $('btn-attack').onclick = () => {
    if (!lastView) return;
    const selection = [...selectedAttack];
    const legalMatch = lastView.legal.find((m) => m.type === 'attack' && sameSet(m.cards, selection));
    if (!legalMatch) return toast(t(lang, 'err_bad_set'));
    socket.emit('move', { move: { type: 'attack', cards: legalMatch.cards } });
    selectedAttack.clear();
  };
  $('btn-swap7').onclick = () => socket.emit('move', { move: { type: 'swap7' } });
  $('btn-leave-game').onclick = () => {
    socket.emit('leaveRoom');
    $('overlay').classList.remove('show');
    showScreen('screen-menu');
  };
  $('btn-rematch').onclick = () => socket.emit('rematch');
  $('btn-menu').onclick = () => {
    socket.emit('leaveRoom');
    $('overlay').classList.remove('show');
    showScreen('screen-menu');
  };

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
        <li>Védéskor húzz egy lapot egy kirakott lapra, ha üti; vagy húzd magadhoz a lapot, ha felveszed.
        Az ütés sosem kötelező, mindig felveheted, amit nem akarsz vagy nem tudsz leütni.</li>
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
        <li>To defend, drag a hand card onto a table card to beat it, or drag a table card onto yourself to
        pick it up. Beating is never mandatory — you can always give up on any card you don't want or can't beat.</li>
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
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── Socket events ────────────────────────────────────────────────
  socket.on('lobby', renderLobby);
  socket.on('game', (data) => {
    animQueue.push(data.view);
    if (animQueue.length === 1) dequeueViews();
  });
  function dequeueViews() {
    if (animQueue.length === 0) return;
    clearTimeout(animTimer);
    const view = animQueue[0];
    const dur = renderGame(view);
    animTimer = setTimeout(() => {
      animQueue.shift();
      dequeueViews();
    }, dur + 80);
  }
  socket.on('errorMsg', (code) => toast(t(lang, 'err_' + code) || t(lang, 'err_generic')));
  socket.on('leftRoom', () => {
    localStorage.removeItem('burge_room');
    localStorage.removeItem('burge_sid');
    showScreen('screen-menu');
  });
  socket.on('joined', ({ code }) => {
    localStorage.setItem('burge_room', code);
    localStorage.setItem('burge_sid', socket.id);
  });
  socket.on('rejoined', ({ code }) => {
    localStorage.setItem('burge_room', code);
    localStorage.setItem('burge_sid', socket.id);
    toast(t(lang, 'reconnected'));
  });

  // Auto-rejoin on (re)connect if we were in a room.
  socket.on('connect', () => {
    const roomCode = localStorage.getItem('burge_room');
    const oldSid = localStorage.getItem('burge_sid');
    if (roomCode && oldSid && oldSid !== socket.id) {
      socket.emit('rejoin', { code: roomCode, oldSid });
    }
  });
  socket.on('disconnect', () => {
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
