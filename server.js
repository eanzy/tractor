const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game } = require('./Game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

const rooms = new Map(); // roomCode -> Game
const socketRoom = new Map(); // socket.id -> roomCode

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function emitState(game) {
  game.broadcast(io);
}

function emitError(socket, message) {
  socket.emit('errorMsg', message);
}

// Poll for expired bidding / friend-call windows so the game auto-advances
// even if the acting player goes idle.
setInterval(() => {
  for (const game of rooms.values()) {
    try {
      if (game.bidWindowExpired()) {
        game.resolveBidding();
        emitState(game);
      } else if (game.bidTiebreakWindowExpired()) {
        // treat unanswered contenders as "no" if the runoff timer expires
        game.forceResolveTiebreak();
        emitState(game);
      } else if (game.trumpSelectWindowExpired()) {
        // declarer stalled on picking trump — default to no-trump
        game.chooseTrump(game.round.declarerId, 'NT');
        emitState(game);
      } else if (game.friendCallWindowExpired()) {
        // auto-pick random friend cards if the declarer stalls
        const r = game.round;
        const needed = r.friendsNeeded;
        const declarerHand = r.hands[r.declarerId];
        const heldKeys = new Set(declarerHand.map(c => `${c.suit}${c.rank}`));
        const { SUITS, RANKS } = require('./cardLogic');
        const candidates = [];
        for (const s of SUITS) for (const rk of RANKS) {
          if (!heldKeys.has(`${s}${rk}`)) candidates.push({ suit: s, rank: rk });
        }
        const picks = [];
        while (picks.length < needed && candidates.length) {
          const i = Math.floor(Math.random() * candidates.length);
          picks.push(candidates.splice(i, 1)[0]);
        }
        game.callFriends(r.declarerId, picks);
        emitState(game);
      }
    } catch (e) {
      // ignore transient errors in the auto-resolve loop
    }
  }
}, 1000);

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    const code = makeRoomCode();
    const game = new Game(code);
    rooms.set(code, game);
    game.addPlayer(socket.id, name || 'Player');
    socket.join(code);
    socketRoom.set(socket.id, code);
    cb && cb({ ok: true, roomCode: code });
    emitState(game);
  });

  socket.on('joinRoom', ({ name, roomCode }, cb) => {
    const code = (roomCode || '').toUpperCase().trim();
    const game = rooms.get(code);
    if (!game) return cb && cb({ ok: false, error: 'Room not found' });
    if (game.players.length >= 8 && !game.getPlayer(socket.id)) {
      return cb && cb({ ok: false, error: 'Room is full' });
    }
    try {
      game.addPlayer(socket.id, name || 'Player');
    } catch (e) {
      return cb && cb({ ok: false, error: e.message });
    }
    socket.join(code);
    socketRoom.set(socket.id, code);
    cb && cb({ ok: true, roomCode: code });
    emitState(game);
  });

  function withGame(cb) {
    const code = socketRoom.get(socket.id);
    const game = rooms.get(code);
    if (!game) return emitError(socket, 'Not in a room');
    try {
      cb(game);
      emitState(game);
    } catch (e) {
      emitError(socket, e.message);
    }
  }

  socket.on('startRound', () => withGame((game) => {
    if (socket.id !== game.hostId) throw new Error('Only the host can start the round');
    if (game.players.filter(p => p.connected).length !== game.players.length) throw new Error('Waiting for all players to be connected');
    game.startRound();
  }));

  socket.on('updateSettings', (patch) => withGame((game) => game.updateSettings(socket.id, patch)));

  socket.on('placeBid', ({ points }) => withGame((game) => game.placeBid(socket.id, points)));
  socket.on('passBid', () => withGame((game) => game.passBid(socket.id)));
  socket.on('answerTiebreak', ({ accept }) => withGame((game) => game.answerTiebreak(socket.id, accept)));
  socket.on('chooseTrump', ({ suit }) => withGame((game) => game.chooseTrump(socket.id, suit)));
  socket.on('buryKitty', ({ cardIds }) => withGame((game) => game.buryKitty(socket.id, cardIds)));
  socket.on('callFriends', ({ calls }) => withGame((game) => game.callFriends(socket.id, calls)));
  socket.on('playCards', ({ cardIds }) => withGame((game) => game.playCards(socket.id, cardIds)));
  socket.on('nextRound', () => withGame((game) => {
    if (socket.id !== game.hostId) throw new Error('Only the host can start the next round');
    game.startRound();
  }));

  socket.on('disconnect', () => {
    const code = socketRoom.get(socket.id);
    const game = rooms.get(code);
    if (game) {
      game.removePlayer(socket.id);
      emitState(game);
    }
    socketRoom.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tractor server listening on port ${PORT}`));
