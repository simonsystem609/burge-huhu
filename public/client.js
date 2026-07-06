/* Bürge / Hühü — client. Browser globals: I18N, Cards, io */
(function () {
  'use strict';

  const socket = io();
  const { t, suitName, cardName } = window.I18N;
  const { cardHTML, cardBackHTML } = window.Cards;

  let lang = localStorage.getItem('burge_lang') || 'hu';
  let lastLobby = null;
  let lastView = null;

  const $ = (id) => document.getElementById(id);
  const qsa = (sel) => Array.from(document.querySelectorAll(sel));

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
    if ($('screen-game').classList.contains('active') && lastView) renderGame(lastView);
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

  $('btn-single').onclick = () =>
    socket.emit('singleplayer', {
      name: myName(),
      lang,
      bots: Number($('bot-count').value),
    });
  $('btn-create').onclick = () => socket.emit('createRoom', { name: myName(), lang });
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

  function renderGame(view) {
    lastView = view;
    showScreen('screen-game');

    // Opponents (everyone but me), in seat order starting after me.
    const oppWrap = $('opponents');
    oppWrap.innerHTML = '';
    const n = view.players.length;
    for (let k = 1; k < n; k++) {
      const p = view.players[(view.you + k) % n];
      const div = document.createElement('div');
      div.className =
        'opp' +
        (p.isAttacker ? ' attacker' : '') +
        (p.isDefender ? ' defender' : '') +
        (p.finished ? ' finished' : '');
      const fan = Array.from({ length: Math.min(p.count, 6) })
        .map(() => cardBackHTML({ small: true }))
        .join('');
      const meta = p.finished
        ? `#${p.finishRank}`
        : `${p.count} 🂠${p.isBot ? ' · BOT' : ''}`;
      div.innerHTML =
        `<div class="fan">${fan || '—'}</div>` +
        `<div class="opp-name">${escapeHtml(p.name)}</div>` +
        `<div class="opp-meta">${meta}</div>`;
      oppWrap.appendChild(div);
    }

    // Trump + talon.
    $('trump-card').innerHTML = cardHTML(view.trumpCard, { small: true });
    $('trump-card').style.opacity = view.trumpInTalon ? '1' : '0.45';
    $('trump-suit-name').textContent = suitName(lang, view.trumpSuit);
    $('talon-card').innerHTML = view.talonCount > 0 ? cardBackHTML({ small: true }) : '';
    $('talon-count').textContent = view.talonCount;

    // Table (attack / defense).
    const tc = $('table-cards');
    if (view.table.attack) {
      const def = view.table.defense
        ? `<div class="defense">${cardHTML(view.table.defense)}</div>`
        : '';
      tc.innerHTML = `<div class="stack">${cardHTML(view.table.attack)}${def}</div>`;
    } else {
      tc.innerHTML = '';
    }

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

    // My hand.
    const hand = $('my-hand');
    hand.innerHTML = '';
    const legalDefend = new Set(
      view.legal.filter((m) => m.type === 'defend').map((m) => m.card)
    );
    const legalAttack = new Set(
      view.legal.filter((m) => m.type === 'attack').map((m) => m.card)
    );
    view.hand.forEach((card) => {
      let selectable = false;
      let disabled = false;
      if (view.yourTurn && view.phase === 'attack') {
        selectable = legalAttack.has(card);
      } else if (view.yourTurn && view.phase === 'defense') {
        selectable = legalDefend.has(card);
        disabled = !selectable;
      } else {
        disabled = true;
      }
      hand.insertAdjacentHTML('beforeend', cardHTML(card, { selectable, disabled }));
    });

    // Action buttons.
    const canTake = view.legal.some((m) => m.type === 'take');
    const canSwap = view.legal.some((m) => m.type === 'swap7');
    $('btn-take').style.display = canTake ? '' : 'none';
    $('btn-swap7').style.display = canSwap ? '' : 'none';

    renderLog(view);

    if (view.phase === 'over') showOver(view);
    else $('overlay').classList.remove('show');
  }

  function renderLog(view) {
    const ul = $('log-list');
    ul.innerHTML = '';
    const nameOf = (i) => (view.players[i] ? view.players[i].name : '?');
    view.log.forEach((e) => {
      const p = e.params || {};
      const params = {
        p: p.player != null ? nameOf(p.player) : '',
        card: p.card ? cardName(lang, p.card) : '',
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

  // ── Game actions ─────────────────────────────────────────────────
  $('my-hand').addEventListener('click', (e) => {
    const el = e.target.closest('.card');
    if (!el || !lastView || !lastView.yourTurn) return;
    const card = el.getAttribute('data-card');
    if (lastView.phase === 'attack') {
      socket.emit('move', { move: { type: 'attack', card } });
    } else if (lastView.phase === 'defense') {
      const ok = lastView.legal.some((m) => m.type === 'defend' && m.card === card);
      if (!ok) return toast(t(lang, 'err_does_not_beat'));
      socket.emit('move', { move: { type: 'defend', card } });
    }
  });
  $('btn-take').onclick = () => socket.emit('move', { move: { type: 'take' } });
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
        <li>A támadó kirak egy lapot. A védő <b>üsse</b> (magasabb azonos színnel, vagy bármelyik aduval), vagy <b>vegye fel</b>.</li>
        <li>Ütés után a lapok a dobóba kerülnek, a védő lesz a következő támadó.</li>
        <li>Felvétel után a védő kimarad, a következő játékos támad.</li>
        <li>Minden kör után 5-re töltötök a pakliból, amíg van lap.</li>
        <li>Az adu VII a saját köröd elején elcserélhető a felfordított adura.</li>
      </ul>`;
    const en = `
      <h4>Goal</h4>
      <ul><li>Get rid of your cards! Whoever is left holding cards is the <b>bürge</b>.</li></ul>
      <h4>Cards</h4>
      <ul><li>32-card Hungarian deck. Suits: Bells, Acorns, Leaves, Hearts.</li>
      <li>Order (weak→strong): VII, VIII, IX, X, Under, Over, King, Ace.</li></ul>
      <h4>Play</h4>
      <ul>
        <li>Everyone gets 5 cards. The flipped card's suit is <b>trump</b>; it goes to the bottom of the draw pile.</li>
        <li>The attacker plays a card. The defender must <b>beat</b> it (higher of the same suit, or any trump) or <b>pick it up</b>.</li>
        <li>If beaten, the cards are discarded and the defender leads next.</li>
        <li>If picked up, the defender is skipped and the next player leads.</li>
        <li>After each round refill to 5 while the pile lasts.</li>
        <li>The trump VII may be swapped for the face-up trump at the start of your turn.</li>
      </ul>`;
    $('rules-body').innerHTML = lang === 'hu' ? hu : en;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── Socket events ────────────────────────────────────────────────
  socket.on('lobby', renderLobby);
  socket.on('game', (data) => renderGame(data.view));
  socket.on('errorMsg', (code) => toast(t(lang, 'err_' + code) || t(lang, 'err_generic')));
  socket.on('leftRoom', () => showScreen('screen-menu'));
  socket.on('joined', () => {});

  // ── Init ─────────────────────────────────────────────────────────
  $('name-input').value = localStorage.getItem('burge_name') || '';
  applyStaticI18n();
  buildRules();
})();
