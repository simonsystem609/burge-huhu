/* Royal Game of Ur — client. */
(function () {
  'use strict';

  const socket = io('/ur', { reconnection: true, reconnectionDelay: 800, reconnectionDelayMax: 4000 });
  const POSITIONS = [
    { id: 0, col: 5, row: 3 },
    { id: 1, col: 6, row: 3 },
    { id: 2, col: 7, row: 3 },
    { id: 3, col: 8, row: 3 },
    { id: 4, col: 5, row: 2 },
    { id: 5, col: 6, row: 2 },
    { id: 6, col: 7, row: 2 },
    { id: 7, col: 8, row: 2 },
    { id: 8, col: 5, row: 4 },
    { id: 9, col: 6, row: 4 },
    { id: 10, col: 7, row: 4 },
    { id: 11, col: 8, row: 4 },
    { id: 12, col: 5, row: 1 },
    { id: 13, col: 6, row: 1 },
    { id: 14, col: 7, row: 1 },
    { id: 15, col: 8, row: 1 },
    { id: 16, col: 10, row: 2 },
    { id: 17, col: 10, row: 3 },
    { id: 18, col: 11, row: 2 },
    { id: 19, col: 11, row: 3 },
  ];
  // Shared zone: positions 0-7
  const SHARED = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
  const ROSETTES = new Set([4, 8, 12, 14, 17]);

  const $ = function (id) { return document.getElementById(id); };

  let lastView = null;
  let selectedPiece = null;

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(function (s) {
      s.classList.toggle('active', s.id === id);
    });
  }

  let toastTimer = null;
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

  // ── Render ──────────────────────────────
  function renderBoard(view) {
    var board = $('board');
    board.innerHTML = '';

    POSITIONS.forEach(function (p) {
      var sq = document.createElement('div');
      sq.className = 'sq';
      if (ROSETTES.has(p.id)) sq.classList.add('rosette');
      if (SHARED.has(p.id)) sq.classList.add('shared');
      sq.style.gridColumn = String(p.col);
      sq.style.gridRow = String(p.row);
      sq.setAttribute('data-pos', p.id);

      if (view.board && view.board[p.id]) {
        view.board[p.id].forEach(function (occ) {
          var piece = document.createElement('div');
          piece.className = 'piece p' + occ.player;
          sq.appendChild(piece);
        });
      }

      board.appendChild(sq);
    });

    // Enable clicks on squares that represent legal destinations
    document.querySelectorAll('#board .sq').forEach(function (sq) {
      sq.classList.remove('selectable');
    });
  }

  function render(view) {
    lastView = view;
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
    rollBtn.disabled = view.phase !== 'roll' || view.turn !== view.you;
    rollBtn.textContent = view.phase === 'roll' && view.turn === view.you ? '🎲 Roll dice' : '🎲 Wait...';

    // Turn info
    var turnInfo = $('turn-info');
    if (view.phase === 'over') {
      turnInfo.textContent = view.winner === view.you ? 'You win!' : (view.winner === null ? 'Draw!' : view.opponent.name + ' wins!');
    } else if (view.phase === 'roll' && view.turn === view.you) {
      turnInfo.textContent = view.extraRoll ? 'Extra roll! Roll again.' : 'Your turn — roll the dice!';
    } else if (view.turn === view.you) {
      turnInfo.textContent = 'Select a piece to move ' + view.lastRoll + ' steps.';
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
      li.textContent = (e.key + ': P' + e.params.player + (e.params.pos != null ? ' → pos ' + e.params.pos : ''));
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

  function homeDots(n) {
    var dots = '';
    for (var i = 0; i < 7; i++) {
      dots += i < n ? '●' : '○';
    }
    return dots;
  }

  // ── Game actions ─────────────────────────
  $('btn-roll').onclick = function () {
    socket.emit('roll');
  };

  $('board').addEventListener('click', function (e) {
    var sq = e.target.closest('.sq');
    if (!sq || !lastView) return;
    if (lastView.turn !== lastView.you || lastView.phase !== 'move') return;
    var pos = parseInt(sq.getAttribute('data-pos'));

    // Check if this square has the player's own piece (select it)
    var ownPiece = null;
    if (lastView.board && lastView.board[pos]) {
      for (var i = 0; i < lastView.board[pos].length; i++) {
        if (lastView.board[pos][i].player === lastView.you) {
          ownPiece = lastView.board[pos][i];
          break;
        }
      }
    }

    if (ownPiece && !selectedPiece) {
      selectedPiece = ownPiece;
      // Highlight this piece's legal destination
      socket.emit('selectPiece', { piece: selectedPiece.piece });
      return;
    }

    if (selectedPiece && pos !== undefined) {
      socket.emit('move', { piece: selectedPiece.piece, destPos: pos });
      selectedPiece = null;
      return;
    }

    selectedPiece = null;
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
  socket.on('game', function (data) { render(data.view); });
  socket.on('errorMsg', function (msg) { toast(msg); });
  socket.on('leftRoom', function () { showScreen('screen-menu'); });
  socket.on('joined', function () {});

  socket.on('disconnect', function () { toast('Connection lost. Reconnecting...'); });

  // ── Init ────────────────────────────────
  showScreen('screen-menu');
})();
