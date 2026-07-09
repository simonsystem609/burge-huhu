/* Royal Game of Ur — client. */
(function () {
  'use strict';

  const socket = io('/ur', { reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 4000 });

  // 3-column × 8-row vertical board layout (matching board-source.png).
  // Each entry has left/top/width/height as % of the .board container.
  const POSITIONS = [
    { id: 0,  left:  1.73, top: 50.69, w: 32.15, h: 12.24 },
    { id: 1,  left:  1.73, top: 62.93, w: 32.15, h: 12.16 },
    { id: 2,  left:  1.73, top: 75.10, w: 32.15, h: 11.70 },
    { id: 3,  left:  1.73, top: 86.80, w: 32.15, h: 12.51 },
    { id: 4,  left: 33.88, top: 50.69, w: 32.63, h: 12.24 },
    { id: 5,  left: 33.88, top: 62.93, w: 32.63, h: 12.16 },
    { id: 6,  left: 33.88, top: 75.10, w: 32.63, h: 11.70 },
    { id: 7,  left: 33.88, top: 86.80, w: 32.63, h: 12.51 },
    { id: 8,  left: 66.51, top: 50.69, w: 32.15, h: 12.24 },
    { id: 9,  left: 66.51, top: 62.93, w: 32.15, h: 12.16 },
    { id: 10, left: 66.51, top: 75.10, w: 32.15, h: 11.70 },
    { id: 11, left: 66.51, top: 86.80, w: 32.15, h: 12.51 },
    { id: 12, left: 33.88, top: 38.18, w: 32.63, h: 12.51 },
    { id: 13, left: 33.88, top: 25.60, w: 32.63, h: 12.59 },
    { id: 14, left:  1.73, top: 13.20, w: 32.15, h: 12.39 },
    { id: 15, left:  1.73, top:  0.58, w: 32.15, h: 12.63 },
    { id: 16, left: 33.88, top:  0.58, w: 32.63, h: 12.63 },
    { id: 17, left: 33.88, top: 13.20, w: 32.63, h: 12.39 },
    { id: 18, left: 66.51, top: 13.20, w: 32.15, h: 12.39 },
    { id: 19, left: 66.51, top:  0.58, w: 32.15, h: 12.63 },
  ];

  const SHARED = new Set([4, 5, 6, 7, 12, 13, 16, 17]);
  const ROSETTES = new Set([0, 8, 15, 19]);

  const $ = function (id) { return document.getElementById(id); };

  let lastView = null;
  let legalMoveMap = null;
  let pendingMove = null; // { destPos, piece } — set on first click, confirmed on second

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function myName() {
    return ($('name-input').value || '').trim() || 'Player';
  }

  function botDelay() {
    return Number($('bot-speed').value) || 700;
  }

  // ── Menu ────────────────────────────────
  $('btn-single').onclick = function () {
    socket.emit('singleplayer', { name: myName(), botDelayMs: botDelay() });
  };
  $('btn-create').onclick = function () {
    socket.emit('createRoom', { name: myName(), botDelayMs: botDelay() });
  };
  $('btn-join').onclick = function () {
    var code = ($('code-input').value || '').trim().toUpperCase();
    if (code.length < 4) return toast('Enter a room code');
    socket.emit('joinRoom', { code: code, name: myName() });
  };
  $('code-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btn-join').click();
  });
  $('btn-start').onclick = function () { socket.emit('startGame'); };
  $('btn-leave-lobby').onclick = function () {
    socket.emit('leaveRoom');
    showScreen('screen-menu');
  };
  $('btn-back').onclick = function () {
    window.location.href = '/';
  };
  $('btn-rematch').onclick = function () { socket.emit('rematch'); };
  $('btn-menu').onclick = function () {
    $('overlay').classList.remove('show');
    showScreen('screen-menu');
    socket.emit('leaveRoom');
  };

  // ── Legal move computation ──────────────
  function computeLegalMoves(view) {
    var map = {};
    if (!view.path || view.lastRoll == null) return map;
    var path = view.path;
    var roll = view.lastRoll;

    for (var i = 0; i < view.pieces.length; i++) {
      var curStep = view.pieces[i].step;
      var destPos = null;

      if (curStep === -1) {
        if (roll === 0) continue;
        var entryPos = path[roll - 1];
        var blocked = false;
        if (view.board && view.board[entryPos]) {
          for (var k = 0; k < view.board[entryPos].length; k++) {
            if (view.board[entryPos][k].player === view.you) { blocked = true; break; }
          }
        }
        if (!blocked) destPos = entryPos;
      } else {
        var remaining = path.length - curStep;
        if (roll === remaining) {
          destPos = -1;
        } else if (roll < remaining) {
          var destStep = curStep + roll;
          var dp = path[destStep];
          var blocked2 = false;
          if (view.board && view.board[dp]) {
            for (var j = 0; j < view.board[dp].length; j++) {
              if (view.board[dp][j].player === view.you) { blocked2 = true; break; }
            }
          }
          if (!blocked2) destPos = dp;
        }
      }

      if (destPos !== null) {
        if (!map[destPos]) map[destPos] = [];
        map[destPos].push(i);
      }
    }
    return map;
  }

  // ── Move preview arrow ───────────────────
  function squareCenter(pos) {
    var sqEl = document.querySelector('.sq[data-pos="' + pos + '"]');
    if (!sqEl) return null;
    var r = sqEl.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  function pieceCurrentPos(pieceIdx) {
    var step = lastView.pieces[pieceIdx].step;
    if (step < 0) return null; // at home, not yet on board
    return lastView.path[step];
  }

  function showMoveArrow(pieceIdx, destPos) {
    var destCenter = squareCenter(destPos);
    if (!destCenter) return;

    var curPos = pieceCurrentPos(pieceIdx);
    var srcCenter, phantom = null;
    if (curPos === null) {
      // Entering from home: a phantom blob hovers above the entry square,
      // its tail tip (= the arrow's start point) touching down near it.
      srcCenter = { x: destCenter.x, y: destCenter.y - destCenter.rect.height * 0.4 };
      phantom = srcCenter;
    } else {
      srcCenter = squareCenter(curPos);
      if (!srcCenter) return;
    }

    var line = $('move-arrow-line');
    line.setAttribute('x1', srcCenter.x);
    line.setAttribute('y1', srcCenter.y);
    line.setAttribute('x2', destCenter.x);
    line.setAttribute('y2', destCenter.y);

    var phantomEl = $('move-phantom-piece');
    if (phantom) {
      // The SVG's viewBox tail-tip sits at local (30, 110); anchor that point at `phantom`.
      phantomEl.style.left = (phantom.x - 30) + 'px';
      phantomEl.style.top = (phantom.y - 110) + 'px';
      phantomEl.setAttribute('class', 'p' + lastView.you);
      phantomEl.style.display = 'block';
    } else {
      phantomEl.style.display = 'none';
    }

    $('move-overlay').classList.add('show');
  }

  function hideMoveArrow() {
    $('move-overlay').classList.remove('show');
    $('move-phantom-piece').style.display = 'none';
  }

  function setPendingMove(destPos, pieceIdx) {
    pendingMove = { destPos: destPos, piece: pieceIdx };
    document.querySelectorAll('.sq.move-pending').forEach(function (s) { s.classList.remove('move-pending'); });
    var destSq = document.querySelector('.sq[data-pos="' + destPos + '"]');
    if (destSq) destSq.classList.add('move-pending');
    showMoveArrow(pieceIdx, destPos);
  }

  function clearPendingMove() {
    pendingMove = null;
    document.querySelectorAll('.sq.move-pending').forEach(function (s) { s.classList.remove('move-pending'); });
    hideMoveArrow();
  }

  // ── Render ──────────────────────────────
  function renderBoard(view) {
    var board = $('board');
    board.innerHTML = '';

    POSITIONS.forEach(function (p) {
      var sq = document.createElement('div');
      sq.className = 'sq';
      if (ROSETTES.has(p.id)) sq.classList.add('rosette');
      else if (SHARED.has(p.id)) sq.classList.add('shared');
      else sq.classList.add('safe');

      // Highlight if legal destination
      var isLegal = legalMoveMap && legalMoveMap[p.id] && legalMoveMap[p.id].length > 0;
      if (isLegal) sq.classList.add('legal-dest');

      // Percentage-based absolute positioning
      sq.style.left = p.left + '%';
      sq.style.top = p.top + '%';
      sq.style.width = p.w + '%';
      sq.style.height = p.h + '%';
      sq.setAttribute('data-pos', p.id);

      // Pieces
      if (view.board && view.board[p.id]) {
        view.board[p.id].forEach(function (occ) {
          var piece = document.createElement('div');
          piece.className = 'piece p' + occ.player;
          if (occ.player === view.you) piece.classList.add('mine');
          sq.appendChild(piece);
        });
      }

      board.appendChild(sq);
    });
  }

  function homeDots(n) {
    var dots = '';
    for (var i = 0; i < 7; i++) {
      dots += i < n ? '\u25CF' : '\u25CB';
    }
    return dots;
  }

  function filledDots(n) {
    var dots = '';
    for (var i = 0; i < n; i++) dots += '\u25CF';
    return dots;
  }

  function renderFinishedTray(containerId, count, playerClass) {
    var el = $(containerId);
    el.innerHTML = '';
    for (var i = 0; i < count; i++) {
      var tok = document.createElement('span');
      tok.className = 'finished-token ' + playerClass;
      el.appendChild(tok);
    }
  }

  function render(view) {
    lastView = view;
    clearPendingMove();

    if (view.phase === 'move' && view.turn === view.you) {
      legalMoveMap = computeLegalMoves(view);
    } else {
      legalMoveMap = null;
    }

    showScreen('screen-game');

    // Opponent panel
    if (view.opponent) {
      $('opp-name').textContent = view.opponent.name + (view.opponent.isBot ? ' (BOT)' : '');
      $('opp-home').textContent = homeDots(view.opponent.homeCount);
      renderFinishedTray('opp-finished', view.opponent.offCount, 'p' + (1 - view.you));
    }

    // Board
    renderBoard(view);

    // Dice / turn
    $('roll-result').textContent = view.lastRoll != null ? String(view.lastRoll) : '';

    var rollBtn = $('btn-roll');
    var isMyRoll = view.phase === 'roll' && view.turn === view.you;
    rollBtn.disabled = !isMyRoll;
    rollBtn.textContent = isMyRoll ? 'Roll dice' : 'Wait...';

    // Bear-off button
    var bearOffBtn = $('btn-bear-off');
    var canBearOff = legalMoveMap && legalMoveMap[-1] && legalMoveMap[-1].length > 0;
    if (canBearOff) {
      bearOffBtn.style.display = 'inline-block';
      bearOffBtn.textContent = 'Bear off (' + legalMoveMap[-1].length + ' pieces)';
    } else {
      bearOffBtn.style.display = 'none';
    }

    // Turn info
    var turnInfo = $('turn-info');
    if (view.phase === 'over') {
      turnInfo.textContent = view.winner === view.you ? 'You win!' : (view.winner === null ? 'Draw!' : view.opponent.name + ' wins!');
    } else if (isMyRoll) {
      turnInfo.textContent = view.extraRoll ? 'Extra roll! Roll again.' : 'Your turn \u2014 roll the dice!';
    } else if (view.turn === view.you) {
      var numMoves = legalMoveMap ? Object.keys(legalMoveMap).length : 0;
      if (numMoves > 0) {
        turnInfo.textContent = 'Click a highlighted square to preview, click again to confirm.';
      } else {
        turnInfo.textContent = 'No legal moves available.';
      }
    } else {
      turnInfo.textContent = view.opponent ? 'Waiting for ' + view.opponent.name + '...' : 'Waiting...';
    }

    // My pieces: dots for remaining (not yet borne off) + tokens for finished
    var myRemaining = view.piecesRemaining || 0;
    $('my-home').textContent = filledDots(myRemaining);
    renderFinishedTray('my-finished', 7 - myRemaining, 'p' + view.you);

    // Log
    var logList = $('log-list');
    logList.innerHTML = '';
    (view.log || []).forEach(function (e) {
      var li = document.createElement('li');
      var desc = e.key;
      if (e.key === 'move') desc = 'P' + e.params.player + ' to pos ' + e.params.pos;
      else if (e.key === 'capture') desc = 'P' + e.params.player + ' captured P' + e.params.opponent;
      else if (e.key === 'bearOff') desc = 'P' + e.params.player + ' bears off';
      else if (e.key === 'win') desc = 'P' + e.params.player + ' wins!';
      li.textContent = desc;
      logList.appendChild(li);
    });
    logList.scrollTop = logList.scrollHeight;

    if (view.phase === 'over') {
      $('over-title').textContent = view.winner === view.you ? 'You win!' : (view.winner === null ? 'Draw!' : view.opponent.name + ' wins!');
      $('overlay').classList.add('show');
    } else {
      $('overlay').classList.remove('show');
    }
  }

  // ── Game actions ─────────────────────────
  $('btn-roll').onclick = function () {
    socket.emit('roll');
  };

  $('btn-bear-off').onclick = function () {
    if (!legalMoveMap || !legalMoveMap[-1] || legalMoveMap[-1].length === 0) return;
    var piece = legalMoveMap[-1][0];
    socket.emit('move', { piece: piece, destPos: -1 });
    legalMoveMap = null;
    clearPendingMove();
  };

  // First click on a highlighted square previews the move with an arrow;
  // clicking that same square again confirms it. Clicking elsewhere cancels
  // the preview (or switches it, if the new square is also a legal dest).
  $('board').addEventListener('click', function (e) {
    if (!lastView || lastView.turn !== lastView.you || lastView.phase !== 'move' || !legalMoveMap) return;

    var sq = e.target.closest('.sq');
    var pos = sq ? parseInt(sq.getAttribute('data-pos')) : NaN;
    var pieces = !isNaN(pos) ? legalMoveMap[pos] : null;

    if (!pieces || pieces.length === 0) {
      clearPendingMove();
      return;
    }

    if (pendingMove && pendingMove.destPos === pos) {
      socket.emit('move', { piece: pendingMove.piece, destPos: pos });
      legalMoveMap = null;
      clearPendingMove();
    } else {
      setPendingMove(pos, pieces[0]);
    }
  });

  // ── Lobby ────────────────────────────────
  function renderLobby(payload) {
    $('lobby-code').textContent = payload.code;
    var list = $('seat-list');
    list.innerHTML = '';
    payload.seats.forEach(function (s) {
      var li = document.createElement('li');
      li.className = 'seat';
      var host = s.sid === payload.hostId ? ' [HOST]' : '';
      var you = s.sid === socket.id ? ' [YOU]' : '';
      li.textContent = s.name + host + you + (s.isBot ? ' (BOT)' : '');
      list.appendChild(li);
    });
    $('btn-start').disabled = payload.seats.length < 2;
    showScreen('screen-lobby');
  }

  $('btn-copy').onclick = function () {
    var code = $('lobby-code').textContent;
    navigator.clipboard.writeText(code).then(function () { toast('Copied!'); }).catch(function () { toast(code); });
  };

  // ── Socket events ────────────────────────
  socket.on('lobby', renderLobby);
  socket.on('game', function (data) {
    render(data.view);
  });
  socket.on('errorMsg', function (msg) { toast(msg); });
  socket.on('leftRoom', function () { showScreen('screen-menu'); });
  socket.on('joined', function () {});

  socket.on('disconnect', function () { toast('Connection lost. Reconnecting...'); });

  // ── Init ────────────────────────────────
  showScreen('screen-menu');
})();
