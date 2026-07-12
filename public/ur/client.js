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
  // Rosettes per Finkel / the British Museum board: path steps 4, 8 and 14.
  // Kept in sync with the server (the game view carries the active set).
  var ROSETTES = new Set([3, 4, 11, 14, 18]);

  const $ = function (id) { return document.getElementById(id); };

  let lastView = null;
  let legalMoveMap = null;   // destPos -> [pieceIdx] (includes -1 for bear-off)
  let sourceMoveMap = null;  // srcPos -> { piece, destPos } for my on-board pieces
  let entryMove = null;      // { piece, destPos } if a home piece can enter
  let pendingMove = null;    // { destPos, piece, srcPos } — set on first click, confirmed on second

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
    return Number($('bot-speed').value) || 1200;
  }

  function gameMode() {
    return $('mode-select').value || 'finkel';
  }

  // Stable per-browser identity (shared with the card game) — lets the
  // server hold our seat across disconnects so a closed tab can resume.
  function clientId() {
    var id = localStorage.getItem('bh_client_id');
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('bh_client_id', id);
    }
    return id;
  }

  // ── Menu ────────────────────────────────
  $('btn-single').onclick = function () {
    socket.emit('singleplayer', { name: myName(), botDelayMs: botDelay(), mode: gameMode(), clientId: clientId() });
  };
  $('btn-create').onclick = function () {
    socket.emit('createRoom', { name: myName(), botDelayMs: botDelay(), mode: gameMode(), clientId: clientId() });
  };
  $('btn-join').onclick = function () {
    var code = ($('code-input').value || '').trim().toUpperCase();
    if (code.length < 4) return toast('Enter a room code');
    socket.emit('joinRoom', { code: code, name: myName(), clientId: clientId() });
  };
  $('code-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btn-join').click();
  });
  $('btn-start').onclick = function () { socket.emit('startGame'); };
  $('btn-leave-lobby').onclick = function () {
    socket.emit('leaveRoom');
    showScreen('screen-menu');
  };
  // Switching games is a deliberate exit: give up our seats first so the
  // card page's auto-resume doesn't bounce us straight back here.
  function gotoCards() {
    socket.emit('abandon', { clientId: clientId() });
    setTimeout(function () { window.location.href = '/'; }, 150);
  }
  $('btn-back').onclick = gotoCards;
  $('btn-goto-cards').onclick = gotoCards;
  $('btn-rematch').onclick = function () { socket.emit('rematch'); };
  $('btn-menu').onclick = function () {
    $('overlay').classList.remove('show');
    showScreen('screen-menu');
    socket.emit('leaveRoom');
  };

  // ── Legal move computation ──────────────
  // Mirrors the engine: a square is landable unless it holds one of my own
  // pieces, or an opponent piece that cannot be captured (outside the shared
  // lane, or on a rosette in modes where rosettes are safe).
  function canLand(view, pos) {
    var occ = view.board && view.board[pos];
    if (!occ || occ.length === 0) return true;
    var other = occ[0];
    if (other.player === view.you) return false;
    if (!SHARED.has(pos)) return false;
    if (view.rosettesSafe && ROSETTES.has(pos)) return false;
    return true;
  }

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
        if (canLand(view, entryPos)) destPos = entryPos;
      } else {
        var remaining = path.length - curStep;
        if (roll === remaining) {
          destPos = -1;
        } else if (roll < remaining) {
          var dp = path[curStep + roll];
          if (canLand(view, dp)) destPos = dp;
        }
      }

      if (destPos !== null) {
        if (!map[destPos]) map[destPos] = [];
        map[destPos].push(i);
      }
    }
    return map;
  }

  // Piece-centric view of the same moves: which of my on-board pieces can
  // move (srcPos -> move), and whether a new piece can enter from home.
  function computeSourceMoves(view) {
    sourceMoveMap = {};
    entryMove = null;
    if (!view.path || view.lastRoll == null) return;
    var path = view.path;
    for (var pos in legalMoveMap) {
      legalMoveMap[pos].forEach(function (pieceIdx) {
        var step = view.pieces[pieceIdx].step;
        var destPos = parseInt(pos, 10);
        if (step === -1) {
          if (!entryMove) entryMove = { piece: pieceIdx, destPos: destPos };
        } else {
          sourceMoveMap[path[step]] = { piece: pieceIdx, destPos: destPos };
        }
      });
    }
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

  // A point in the empty margin beside the board, level with a given square —
  // used as the "prep" spot for pieces entering and the "finish" spot for
  // pieces bearing off, whichever side (left/right) that square is nearer to.
  function marginPoint(squareRect) {
    var boardRect = $('board').getBoundingClientRect();
    var tableRect = document.querySelector('.table-ur').getBoundingClientRect();
    var cx = squareRect.left + squareRect.width / 2;
    var cy = squareRect.top + squareRect.height / 2;
    var isLeft = (cx - boardRect.left) < (boardRect.right - cx);
    var margin = isLeft ? (boardRect.left - tableRect.left) : (tableRect.right - boardRect.right);
    var offset = Math.max(30, Math.min(squareRect.width * 0.9, margin * 0.6, 90));
    var x = isLeft ? (boardRect.left - offset) : (boardRect.right + offset);
    return { x: x, y: cy };
  }

  // Step index of a board position within the CURRENT piece's path (the two
  // players' paths differ), or -1 if it isn't on it.
  function pathStepOf(pos) {
    return lastView.path.indexOf(pos);
  }

  // Centers of every square from fromStep+1 through toStep, inclusive, in
  // path order — the squares a piece actually crosses making this move, so
  // the preview arrow can bend through them instead of cutting a straight
  // line across the board.
  function pathWaypoints(fromStep, toStep) {
    var pts = [];
    for (var st = fromStep + 1; st <= toStep; st++) {
      var c = squareCenter(lastView.path[st]);
      if (c) pts.push({ x: c.x, y: c.y });
    }
    return pts;
  }

  function showMoveArrow(pieceIdx, destPos) {
    var curPos = pieceCurrentPos(pieceIdx);
    var curStep = lastView.pieces[pieceIdx].step;
    var srcCenter, phantom = null, points;

    if (destPos === -1) {
      // Bearing off: through whatever squares remain on the path, then out
      // to the finish spot in the margin beside the board.
      srcCenter = squareCenter(curPos);
      if (!srcCenter) return;
      var remaining = pathWaypoints(curStep, lastView.path.length - 1);
      var finish = marginPoint(srcCenter.rect);
      points = [srcCenter].concat(remaining).concat([finish]);
    } else if (curPos === null) {
      // Entering from home: a piece token sits in the margin beside the
      // board, level with the entry square — a "prep square" just outside
      // the board proper. A direct hop; there's no path yet to trace.
      var destCenter = squareCenter(destPos);
      if (!destCenter) return;
      srcCenter = marginPoint(destCenter.rect);
      phantom = srcCenter;
      points = [srcCenter, destCenter];
    } else {
      srcCenter = squareCenter(curPos);
      if (!srcCenter) return;
      var destStep = pathStepOf(destPos);
      var hop = destStep > curStep ? pathWaypoints(curStep, destStep) : [squareCenter(destPos)];
      points = [srcCenter].concat(hop);
    }

    var line = $('move-arrow-line');
    line.setAttribute(
      'points',
      points.map(function (p) { return p.x + ',' + p.y; }).join(' ')
    );

    var phantomEl = $('move-phantom-piece');
    if (phantom) {
      phantomEl.style.left = phantom.x + 'px';
      phantomEl.style.top = phantom.y + 'px';
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

  // ── Dice roll animation ──────────────────
  // 4 tetrahedral dice, top view: each die shows a white pip when its marked
  // tip lands up; the roll is how many pips show. The dice tumble in the
  // side margin — right of the board for player 0 (whose lane is the right
  // column), left for player 1 — then settle on an arrangement matching the
  // actual roll.
  var diceTimers = [];

  function playDiceAnimation(player, roll) {
    var wrap = $('dice-anim');
    var board = $('board');
    if (!wrap || !board || !document.getElementById('screen-game').classList.contains('active')) return;

    diceTimers.forEach(clearTimeout);
    diceTimers = [];

    var boardRect = board.getBoundingClientRect();
    var tableRect = document.querySelector('.table-ur').getBoundingClientRect();
    var x = player === 0
      ? (boardRect.right + tableRect.right) / 2
      : (tableRect.left + boardRect.left) / 2;
    wrap.style.left = x + 'px';
    wrap.style.top = (boardRect.top + boardRect.height / 2) + 'px';

    // Mode-aware: Masters throws 3 dice and a zero counts as 4 (shown as
    // three unmarked dice); Finkel/Blitz throw 4.
    var diceCount = (lastView && lastView.diceCount) || 4;
    var zeroAs4 = !!(lastView && lastView.zeroAs4);
    var marks = zeroAs4 && roll === 4 ? 0 : Math.min(roll, diceCount);

    var dice = Array.prototype.slice.call(wrap.querySelectorAll('.die'), 0, 4);
    dice.forEach(function (d, i) {
      d.style.display = i < diceCount ? '' : 'none';
    });
    var live = dice.slice(0, diceCount);
    $('dice-total').textContent = '';
    wrap.classList.remove('settled');
    wrap.classList.add('show');

    // Tumble phase: randomize rotations and pips every 90ms
    var elapsed = 0;
    function tumble() {
      live.forEach(function (d) {
        d.style.transform = 'rotate(' + Math.floor(Math.random() * 360) + 'deg)';
        d.classList.toggle('marked', Math.random() < 0.5);
      });
      elapsed += 90;
      if (elapsed < 900) {
        diceTimers.push(setTimeout(tumble, 90));
      } else {
        settle();
      }
    }

    function settle() {
      // Random arrangement with exactly `marks` marked dice
      var idx = [];
      for (var k = 0; k < live.length; k++) idx.push(k);
      for (var i = idx.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      var marked = new Set(idx.slice(0, marks));
      live.forEach(function (d, i2) {
        d.style.transform = 'rotate(' + (Math.floor(Math.random() * 30) - 15) + 'deg)';
        d.classList.toggle('marked', marked.has(i2));
      });
      $('dice-total').textContent = String(roll);
      wrap.classList.add('settled');
      diceTimers.push(setTimeout(function () {
        wrap.classList.remove('show', 'settled');
      }, 1600));
    }

    tumble();
  }

  function setPendingMove(destPos, pieceIdx) {
    // The square whose click confirms the move: the destination square for a
    // normal move, or the piece's own square for a bear-off (no dest square).
    var confirmPos = destPos === -1 ? pieceCurrentPos(pieceIdx) : destPos;
    pendingMove = { destPos: destPos, piece: pieceIdx, confirmPos: confirmPos };
    document.querySelectorAll('.sq.move-pending').forEach(function (s) { s.classList.remove('move-pending'); });
    var confirmSq = document.querySelector('.sq[data-pos="' + confirmPos + '"]');
    if (confirmSq) confirmSq.classList.add('move-pending');
    showMoveArrow(pieceIdx, destPos);
  }

  function clearPendingMove() {
    pendingMove = null;
    document.querySelectorAll('.sq.move-pending').forEach(function (s) { s.classList.remove('move-pending'); });
    hideMoveArrow();
  }

  // ── Render ──────────────────────────────
  function renderBoard(view) {
    // Squares are static per game; pieces live in a separate layer and are
    // moved with CSS transitions so every move animates — bots included.
    ensureBoardLayers();
    POSITIONS.forEach(function (p) {
      var sq = document.querySelector('#squares .sq[data-pos="' + p.id + '"]');
      if (!sq) return;
      sq.classList.toggle('rosette', ROSETTES.has(p.id));
      sq.classList.toggle('shared', !ROSETTES.has(p.id) && SHARED.has(p.id));
      sq.classList.toggle('safe', !ROSETTES.has(p.id) && !SHARED.has(p.id));
      // Only the entry square for a NEW piece is highlighted up front;
      // destinations for pieces already on the board appear when the
      // player clicks one of their pieces.
      sq.classList.toggle('legal-dest', !!(entryMove && entryMove.destPos === p.id));
    });
    renderPieces(view);
  }

  var boardLayersBuilt = false;
  function ensureBoardLayers() {
    if (boardLayersBuilt) return;
    var board = $('board');
    board.innerHTML = '<div id="squares"></div><div id="piece-layer"></div>';
    var wrap = document.getElementById('squares');
    POSITIONS.forEach(function (p) {
      var sq = document.createElement('div');
      sq.className = 'sq';
      sq.style.left = p.left + '%';
      sq.style.top = p.top + '%';
      sq.style.width = p.w + '%';
      sq.style.height = p.h + '%';
      sq.setAttribute('data-pos', p.id);
      wrap.appendChild(sq);
    });
    boardLayersBuilt = true;
  }

  // Centre of each square in board-percent coordinates.
  var POS_CENTER = {};
  POSITIONS.forEach(function (p) {
    POS_CENTER[p.id] = { x: p.left + p.w / 2, y: p.top + p.h / 2 };
  });

  // Home stack in the margin beside the player's own lane (player 0 owns the
  // right column, player 1 the left); borne-off pieces exit near the top.
  function homePct(player, slot) {
    return { x: player === 0 ? 109 : -9, y: 92 - slot * 6.5 };
  }
  function exitPct(player) {
    return { x: player === 0 ? 109 : -9, y: 7 };
  }

  var oppMemory = { state: {}, offCount: 0 }; // inferred opponent piece states

  function getPieceEl(key, playerClass) {
    var layer = document.getElementById('piece-layer');
    var el = layer.querySelector('[data-key="' + key + '"]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'gpiece ' + playerClass;
      el.setAttribute('data-key', key);
      layer.appendChild(el);
    }
    return el;
  }

  function placePiece(el, pct, hidden) {
    el.style.left = pct.x + '%';
    el.style.top = pct.y + '%';
    el.style.opacity = hidden ? '0' : '1';
  }

  function renderPieces(view) {
    var me = view.you;
    var opp = 1 - me;
    var count = view.pieceCount || 7;
    var layer = document.getElementById('piece-layer');

    var offNow = view.opponent ? view.opponent.offCount || 0 : 0;
    var fresh =
      view.pieces.every(function (p) { return p.step === -1; }) &&
      (!view.board || Object.keys(view.board).length === 0) &&
      offNow === 0;
    if (fresh) {
      layer.innerHTML = '';
      oppMemory = { state: {}, offCount: 0 };
    }

    // My pieces — identity is exact (step per piece index).
    var myHomeSlot = 0;
    view.pieces.forEach(function (ps, i) {
      var el = getPieceEl('m' + i, 'p' + me + ' mine');
      if (ps.step === -1) placePiece(el, homePct(me, myHomeSlot++));
      else if (ps.step >= view.path.length) placePiece(el, exitPct(me), true);
      else placePiece(el, POS_CENTER[view.path[ps.step]]);
    });

    // Opponent pieces — board gives identity; home vs borne-off is inferred
    // from the off-count delta (one move happens per view).
    var onBoard = {};
    if (view.board) {
      Object.keys(view.board).forEach(function (pos) {
        view.board[pos].forEach(function (occ) {
          if (occ.player === opp) onBoard[occ.piece] = Number(pos);
        });
      });
    }
    var offDelta = offNow - oppMemory.offCount;
    var oppHomeSlot = 0;
    for (var i2 = 0; i2 < count; i2++) {
      var el2 = getPieceEl('o' + i2, 'p' + opp);
      if (onBoard[i2] != null) {
        oppMemory.state[i2] = 'board';
        placePiece(el2, POS_CENTER[onBoard[i2]]);
      } else {
        if (oppMemory.state[i2] === 'board') {
          if (offDelta > 0) { oppMemory.state[i2] = 'off'; offDelta--; }
          else oppMemory.state[i2] = 'home';
        } else if (!oppMemory.state[i2]) {
          oppMemory.state[i2] = 'home';
        }
        if (oppMemory.state[i2] === 'off') placePiece(el2, exitPct(opp), true);
        else placePiece(el2, homePct(opp, oppHomeSlot++));
      }
    }
    oppMemory.offCount = offNow;
  }

  function homeDots(n, total) {
    var dots = '';
    for (var i = 0; i < (total || 7); i++) {
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
    if (view.rosettes) ROSETTES = new Set(view.rosettes);
    clearPendingMove();

    if (view.phase === 'move' && view.turn === view.you) {
      legalMoveMap = computeLegalMoves(view);
      computeSourceMoves(view);
    } else {
      legalMoveMap = null;
      sourceMoveMap = null;
      entryMove = null;
    }

    showScreen('screen-game');

    // Opponent panel
    if (view.opponent) {
      $('opp-name').textContent = view.opponent.name + (view.opponent.isBot ? ' (BOT)' : '');
      $('opp-home').textContent = homeDots(view.opponent.homeCount, view.pieceCount);
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
    turnInfo.classList.toggle('you', view.phase !== 'over' && (isMyRoll || view.turn === view.you));
    if (view.phase === 'over') {
      turnInfo.textContent = view.winner === view.you ? 'You win!' : (view.winner === null ? 'Draw!' : view.opponent.name + ' wins!');
    } else if (isMyRoll) {
      turnInfo.textContent = view.extraRoll ? 'Extra roll! Roll again.' : 'Your turn \u2014 roll the dice!';
    } else if (view.turn === view.you) {
      var numMoves = legalMoveMap ? Object.keys(legalMoveMap).length : 0;
      if (numMoves > 0) {
        turnInfo.textContent = entryMove
          ? 'Click a piece (or the highlighted entry square) to preview a move, click the highlight to confirm.'
          : 'Click one of your pieces to preview its move, then click the highlight to confirm.';
      } else {
        turnInfo.textContent = 'No legal moves available.';
      }
    } else {
      turnInfo.textContent = view.opponent ? 'Waiting for ' + view.opponent.name + '...' : 'Waiting...';
    }

    // My pieces: dots for remaining (not yet borne off) + tokens for finished
    var myRemaining = view.piecesRemaining || 0;
    $('my-home').textContent = filledDots(myRemaining);
    renderFinishedTray('my-finished', (view.pieceCount || 7) - myRemaining, 'p' + view.you);

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

  // Piece-first interaction: click one of your pieces (or the pre-highlighted
  // entry square) to preview its move — arrow plus a highlight on where it
  // will land. Clicking that highlight confirms; clicking another of your
  // pieces switches the preview; clicking anywhere else cancels it.
  $('board').addEventListener('click', function (e) {
    if (!lastView || lastView.turn !== lastView.you || lastView.phase !== 'move' || !legalMoveMap) return;

    var sq = e.target.closest('.sq');
    var pos = sq ? parseInt(sq.getAttribute('data-pos')) : NaN;
    if (isNaN(pos)) { clearPendingMove(); return; }

    // Confirm: click on the pending highlight (dest square, or the piece's
    // own square for a bear-off).
    if (pendingMove && pendingMove.confirmPos === pos) {
      socket.emit('move', { piece: pendingMove.piece, destPos: pendingMove.destPos });
      legalMoveMap = null;
      clearPendingMove();
      return;
    }

    // Preview: click one of my movable pieces.
    if (sourceMoveMap && sourceMoveMap[pos]) {
      setPendingMove(sourceMoveMap[pos].destPos, sourceMoveMap[pos].piece);
      return;
    }

    // Preview: click the highlighted entry square for a new piece.
    if (entryMove && entryMove.destPos === pos) {
      setPendingMove(entryMove.destPos, entryMove.piece);
      return;
    }

    clearPendingMove();
  });

  // ── Lobby ────────────────────────────────
  var MODE_LABELS = {
    finkel: 'Finkel — classic: 7 pieces, rosettes are safe',
    masters: 'Masters — longer path, 3 dice (0 = 4), rosettes unsafe',
    blitz: 'Blitz — 5 pieces, captures grant an extra roll',
  };

  function renderLobby(payload) {
    $('lobby-code').textContent = payload.code;
    $('lobby-mode').textContent = 'Rules: ' + (MODE_LABELS[payload.mode] || MODE_LABELS.finkel);
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
  socket.on('rolled', function (data) {
    playDiceAnimation(data.player, data.roll);
  });
  socket.on('errorMsg', function (msg) { toast(msg); });
  // The code belongs to a card-game room — hop over there with the code
  // prefilled so the join completes automatically.
  socket.on('wrongGame', function (d) {
    toast('That code is a card game room — taking you there…');
    setTimeout(function () {
      window.location.href = '/?join=' + encodeURIComponent((d && d.code) || '');
    }, 1500);
  });
  socket.on('leftRoom', function () { showScreen('screen-menu'); });
  socket.on('joined', function () {});
  socket.on('resumed', function () { toast('Reconnected — the game picks up where you left it.'); });
  // Our unfinished room lives in the card game — go there and resume.
  socket.on('resumeElsewhere', function (d) {
    if (d && d.game === 'cards') window.location.href = '/';
  });

  socket.on('disconnect', function () { toast('Connection lost. Reconnecting...'); });

  // A ?join=CODE in the URL (arriving from the card game's redirect) joins
  // that room as soon as the socket is up; otherwise ask the server whether
  // this browser has a seat to come back to.
  var pendingJoin = null;
  var joinParam = new URLSearchParams(window.location.search).get('join');
  if (joinParam) {
    pendingJoin = joinParam.trim().toUpperCase();
    $('code-input').value = pendingJoin;
    history.replaceState(null, '', window.location.pathname);
  }
  socket.on('connect', function () {
    if (pendingJoin) {
      var code = pendingJoin;
      pendingJoin = null;
      socket.emit('joinRoom', { code: code, name: myName(), clientId: clientId() });
      return;
    }
    socket.emit('resume', { clientId: clientId() });
  });

  // ── Init ────────────────────────────────
  showScreen('screen-menu');
})();
