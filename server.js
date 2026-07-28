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
// a reconnect (refresh, network drop) gets a brand-new socket.id, so the STABLE player id
// (assigned once, on first join) is tracked separately from whichever socket is currently live
const socketPlayerId = new Map(); // socket.id -> stable player id
// reverse of the above: Socket.IO only auto-routes a message to a socket via a room matching
// its OWN (current) id, so broadcasting to a player's STABLE id silently reaches nobody once
// that id no longer belongs to any live socket (i.e. after any reconnect). This map is the only
// reliable way to find "which socket is currently live for this player" when emitting state.
const playerSocketId = new Map(); // stable player id -> current socket.id

function linkPlayer(playerId, socketId) {
  socketPlayerId.set(socketId, playerId);
  playerSocketId.set(playerId, socketId);
}
function unlinkSocket(socketId) {
  const playerId = socketPlayerId.get(socketId);
  if (playerId && playerSocketId.get(playerId) === socketId) playerSocketId.delete(playerId);
  socketPlayerId.delete(socketId);
  socketRoom.delete(socketId);
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function emitState(game) {
  for (const p of game.players) {
    const socketId = playerSocketId.get(p.id);
    if (!socketId) continue; // no live connection for this player right now
    io.to(socketId).emit('state', game.publicState(p.id));
  }
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
    linkPlayer(socket.id, socket.id);
    cb && cb({ ok: true, roomCode: code, playerId: socket.id });
    emitState(game);
  });

  socket.on('joinRoom', ({ name, roomCode }, cb) => {
    const code = (roomCode || '').toUpperCase().trim();
    const game = rooms.get(code);
    if (!game) return cb && cb({ ok: false, error: 'Room not found' });
    const cleanName = (name || 'Player').trim() || 'Player';

    // a disconnected player with the same name reclaims their original seat/hand/level under
    // their existing stable id, instead of being added as a brand-new player
    const existing = game.findDisconnectedByName(cleanName);
    if (existing) {
      game.reconnectPlayer(existing.id);
      socket.join(code);
      socketRoom.set(socket.id, code);
      linkPlayer(existing.id, socket.id);
      cb && cb({ ok: true, roomCode: code, playerId: existing.id });
      emitState(game);
      return;
    }

    if (game.players.length >= 8) {
      return cb && cb({ ok: false, error: 'Room is full' });
    }
    try {
      game.addPlayer(socket.id, cleanName);
    } catch (e) {
      return cb && cb({ ok: false, error: e.message });
    }
    socket.join(code);
    socketRoom.set(socket.id, code);
    linkPlayer(socket.id, socket.id);
    cb && cb({ ok: true, roomCode: code, playerId: socket.id });
    emitState(game);
  });

  function withGame(cb) {
    const code = socketRoom.get(socket.id);
    const game = rooms.get(code);
    if (!game) return emitError(socket, 'Not in a room');
    const playerId = socketPlayerId.get(socket.id) || socket.id;
    try {
      cb(game, playerId);
      emitState(game);
    } catch (e) {
      emitError(socket, e.message);
    }
  }

  socket.on('startRound', () => withGame((game, playerId) => {
    if (playerId !== game.hostId) throw new Error('Only the host can start the round');
    if (game.players.filter(p => p.connected).length !== game.players.length) throw new Error('Waiting for all players to be connected');
    game.startRound();
  }));

  socket.on('updateSettings', (patch) => withGame((game, playerId) => game.updateSettings(playerId, patch)));

  socket.on('assignPlayerTeam', ({ playerId: targetId, team }) => withGame((game, playerId) => game.assignPlayerTeam(playerId, targetId, team)));
  socket.on('confirmTeams', () => withGame((game, playerId) => game.confirmTeams(playerId)));

  socket.on('kickPlayer', ({ playerId: targetId }) => withGame((game, playerId) => {
    const removedId = game.kickPlayer(playerId, targetId);
    const kickedSocketId = playerSocketId.get(removedId);
    if (kickedSocketId) {
      const kickedSocket = io.sockets.sockets.get(kickedSocketId);
      if (kickedSocket) {
        kickedSocket.emit('kicked');
        kickedSocket.leave(socketRoom.get(kickedSocketId));
      }
      unlinkSocket(kickedSocketId);
    }
  }));

  socket.on('placeBid', ({ points }) => withGame((game, playerId) => game.placeBid(playerId, points)));
  socket.on('passBid', () => withGame((game, playerId) => game.passBid(playerId)));
  socket.on('answerTiebreak', ({ accept }) => withGame((game, playerId) => game.answerTiebreak(playerId, accept)));
  socket.on('chooseTrump', ({ suit }) => withGame((game, playerId) => game.chooseTrump(playerId, suit)));
  socket.on('buryKitty', ({ cardIds }) => withGame((game, playerId) => game.buryKitty(playerId, cardIds)));
  socket.on('callFriends', ({ calls }) => withGame((game, playerId) => game.callFriends(playerId, calls)));
  socket.on('playCards', ({ cardIds }) => withGame((game, playerId) => game.playCards(playerId, cardIds)));
  socket.on('nextRound', () => withGame((game, playerId) => {
    if (playerId !== game.hostId) throw new Error('Only the host can start the next round');
    game.startRound();
  }));

  // Host closes the table for everyone. This tears the whole room down rather than mutating
  // game state, so it bypasses withGame()'s normal "run action, then broadcast state" flow --
  // there's no more game/room left to broadcast state for once this is done.
  socket.on('endGame', () => {
    const code = socketRoom.get(socket.id);
    const game = rooms.get(code);
    if (!game) return emitError(socket, 'Not in a room');
    const playerId = socketPlayerId.get(socket.id) || socket.id;
    if (playerId !== game.hostId) return emitError(socket, 'Only the host can end the game');

    for (const p of game.players) {
      const sid = playerSocketId.get(p.id);
      if (!sid) continue;
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.emit('gameEnded');
        s.leave(code);
      }
      unlinkSocket(sid);
    }
    rooms.delete(code);
  });

  socket.on('disconnect', () => {
    const code = socketRoom.get(socket.id);
    const game = rooms.get(code);
    const playerId = socketPlayerId.get(socket.id);
    unlinkSocket(socket.id);
    if (game && playerId) {
      game.removePlayer(playerId);
      emitState(game);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tractor server listening on port ${PORT}`));
