/* Royal Game of Ur — client. */
(function () {
  'use strict';

  const socket = io('/ur', { reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 4000 });

  // Board layout (matches engine):
  //   Left block (3x4):       Bridge:       Right block (3x2):
  //   [ 0][ 1][ 2][ 3]         .  .         [14][15]
  //   [ 4][ 5][ 6][ 7]       [12][13]       [16][17]
  //   [ 8][ 9][10][11]         .  .         [18][19]
  const POSITIONS = [
    { id: 0,  col: 1, row: 1 },
    { id: 1,  col: 2, row: 1 },
    { id: 2,  col: 3, row: 1 },
    { id: 3,  col: 4, row: 1 },
    { id: 4,  col: 1, row: 2 },
    { id: 5,  col: 2, row: 2 },
    { id: 6,  col: 3, row: 2 },
    { id: 7,  col: 4, row: 2 },
    { id: 8,  col: 1, row: 3 },
    { id: 9,  col: 2, row: 3 },
    { id: 10, col: 3, row: 3 },
    { id: 11, col: 4, row: 3 },
    { id: 12, col: 5, row: 2 },
    { id: 13, col: 6, row: 2 },
    { id: 14, col: 7, row: 1 },
    { id: 15, col: 8, row: 1 },
    { id: 16, col: 7, row: 2 },
    { id: 17, col: 8, row: 2 },
    { id: 18, col: 7, row: 3 },
    { id: 19, col: 8, row: 3 },
  ];

  const SHARED = new Set([4, 5, 6, 7, 12, 13, 16, 17]);
  const ROSETTES = new Set([0, 4, 8, 14, 18]);

  const $ = function (id) { return document.getElementById(id); };

  let lastView = null;

  // Map of destPos -> piece index for legal moves
  let legalMoveMap = null;

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
  // Builds a map: destPos -> [pieceIdx, ...]
  function computeLegalMoves(view) {
    var map = {};
    if (!view.path || view.lastRoll == null) return map;
    var path = view.path;
    var roll = view.lastRoll;

    for (var i = 0; i < view.pieces.length; i++) {
      var curStep = view.pieces[i].step;
      var destPos = null;

      if (curStep === -1) {
        // Piece at home: can enter if roll > 0 and entry not blocked
        if (roll === 0) continue;
        var entryPos = path[0];
        var blocked = false;
        if (view.board && view.board[entryPos]) {
          for (var k = 0; k < view.board[entryPos].length; k++) {
            if (view.board[entryPos][k].player === view.you) { blocked = true; break; }
          }
        }
        if (!blocked) destPos = entryPos;
      } else {
        // Piece on board
        var remaining = path.length - curStep;
        if (roll === remaining) {
          // Bear off: use -1 as sentinel
          destPos = -1;
        } else if (roll < remaining) {
          var destStep = curStep + roll;
          var dp = path[destStep];
          // Check not blocked by own piece
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

      sq.style.gridColumn = String(p.col);
      sq.style.gridRow = String(p.row);
      sq.setAttribute('data-pos', p.id);

      // Rosette star
      if (ROSETTES.has(p.id)) {
        var star = document.createElement('span');
        star.className = 'rosette-star';
        star.textContent = '\u2605';
        sq.appendChild(star);
      }

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

  function render(view) {
    lastView = view;

    // Compute legal moves in move phase
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
      if (view.opponent.offCount > 0) {
        $('opp-off').textContent = view.opponent.offCount + ' borne off';
      } else {
        $('opp-off').textContent = '';
      }
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
        turnInfo.textContent = 'Click a highlighted square to move ' + view.lastRoll + ' steps.';
      } else {
        turnInfo.textContent = 'No legal moves available.';
      }
    } else {
      turnInfo.textContent = view.opponent ? 'Waiting for ' + view.opponent.name + '...' : 'Waiting...';
    }

    // My pieces remaining
    $('my-remaining').textContent = view.piecesRemaining || 0;

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

  // Bear off button
  $('btn-bear-off').onclick = function () {
    if (!legalMoveMap || !legalMoveMap[-1] || legalMoveMap[-1].length === 0) return;
    // Bear off the first piece that can bear off
    var piece = legalMoveMap[-1][0];
    socket.emit('move', { piece: piece, destPos: -1 });
    legalMoveMap = null;
  };

  // Click on board square → move if it's a legal destination
  $('board').addEventListener('click', function (e) {
    var sq = e.target.closest('.sq');
    if (!sq || !lastView) return;
    if (lastView.turn !== lastView.you || lastView.phase !== 'move') return;
    var pos = parseInt(sq.getAttribute('data-pos'));
    if (isNaN(pos) || !legalMoveMap) return;

    var pieces = legalMoveMap[pos];
    if (!pieces || pieces.length === 0) return;

    // Move the first matching piece
    socket.emit('move', { piece: pieces[0], destPos: pos });
    legalMoveMap = null;
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
