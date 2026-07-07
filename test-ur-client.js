'use strict';
const { io } = require('socket.io-client');

const PORT = 3000;
const URL = `http://localhost:${PORT}/ur`;

const socket = io(URL, { reconnection: false, transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  console.log('Connected, socket ID:', socket.id);
  console.log('Starting singleplayer game...');
  socket.emit('singleplayer', { name: 'TestPlayer', botDelayMs: 100 });
});

socket.on('joined', (data) => {
  console.log('Joined room:', data.code);
});

socket.on('game', (data) => {
  const v = data.view;
  console.log('\n--- GAME STATE ---');
  console.log('Phase:', v.phase, 'Turn:', v.turn, 'You:', v.you);
  console.log('Last roll:', v.lastRoll);
  console.log('Extra roll:', v.extraRoll);
  console.log('Winner:', v.winner);
  console.log('Board:', JSON.stringify(v.board));
  console.log('Pieces:', JSON.stringify(v.pieces));
  console.log('Opponent:', JSON.stringify(v.opponent));
  console.log('------------------\n');

  if (v.phase === 'over') {
    console.log('GAME OVER! Winner:', v.winner === v.you ? 'You!' : v.opponent.name);
    socket.disconnect();
    return;
  }

  // If it's my turn to roll, roll
  if (v.phase === 'roll' && v.turn === v.you) {
    console.log('My turn to roll, rolling...');
    setTimeout(() => {
      socket.emit('roll');
    }, 200);
    return;
  }

  // If it's my turn to move, make a legal move
  if (v.phase === 'move' && v.turn === v.you) {
    // Get legal moves from the server perspective
    // We need to find our pieces and pick a move
    const myPieces = v.pieces || [];
    const path = v.path || [];
    
    // Find a piece that can move
    for (let i = 0; i < myPieces.length; i++) {
      const step = myPieces[i].step;
      if (step === -1) {
        // Piece at home, try to enter
        const entryPos = path[0];
        // Check if entry is blocked by own piece
        let blocked = false;
        if (v.board && v.board[entryPos]) {
          for (const occ of v.board[entryPos]) {
            if (occ.player === v.you) { blocked = true; break; }
          }
        }
        if (!blocked) {
          console.log(`Moving piece ${i} from home to pos ${entryPos}`);
          socket.emit('move', { piece: i, destPos: entryPos });
          return;
        }
      } else {
        // Piece on board
        const roll = v.lastRoll;
        if (roll != null) {
          const remaining = path.length - step;
          if (roll === remaining) {
            // Bear off
            console.log(`Bearing off piece ${i}`);
            socket.emit('move', { piece: i, destPos: -1 });
            return;
          } else if (roll < remaining) {
            const destStep = step + roll;
            const destPos = path[destStep];
            // Check if destination is blocked by own piece
            let blocked2 = false;
            if (v.board && v.board[destPos]) {
              for (const occ of v.board[destPos]) {
                if (occ.player === v.you) { blocked2 = true; break; }
              }
            }
            if (!blocked2) {
              console.log(`Moving piece ${i} from step ${step} to pos ${destPos} (destStep ${destStep})`);
              socket.emit('move', { piece: i, destPos });
              return;
            }
          }
        }
      }
    }
    console.log('No legal move found!');
  }
});

socket.on('errorMsg', (msg) => {
  console.log('Error:', msg);
});

socket.on('disconnect', () => {
  console.log('Disconnected');
});

setTimeout(() => {
  console.log('Timeout - forcing disconnect');
  socket.disconnect();
  process.exit(0);
}, 10000);
