const {
  RANKS, buildShoe, shuffle, computeDealPlan, isTrump,
  cardStrength, pointValue, suitGroup, cardKey, classifyCombo, comboStrength, totalPoints,
  SUIT_SYMBOL, cardLabel,
} = require('./cardLogic');

const FRIEND_CALL_WINDOW_MS = 30000;
const KITTY_WINDOW_MS = 45000;
const BID_TIEBREAK_WINDOW_MS = 15000;
const TRUMP_SELECT_WINDOW_MS = 20000;

const BID_TIMER_OPTIONS_MS = [0, 30000, 60000]; // 0 = no timer, players bid on their own schedule
const DEFAULT_BID_TIMER_MS = 30000;

const MIN_BID_POINTS = 40;
const MAX_BID_POINTS = 200;
const BID_POINTS_STEP = 5;
const DEFAULT_BID_POINTS = 80;

const CHECKPOINT_RANKS = ['5', '10', 'K', 'A'];
const MAX_CHECKPOINT_EXTRA = 5;

function friendsNeeded(numPlayers) {
  if (numPlayers === 3) return 0; // 3-player games: declarer plays solo against the other two, no friend calling
  // declarer's side should end up the (rounded-up) majority
  const declarerTeamSize = Math.floor(numPlayers / 2);
  return declarerTeamSize - 1;
}

class Game {
  constructor(roomCode) {
    this.roomCode = roomCode;
    this.phase = 'lobby'; // lobby -> dealing -> bidding -> bidtiebreak -> trumpselect -> kitty -> friendcall -> playing -> scoring -> lobby
    this.players = []; // { id, name, seat, connected }
    this.hostId = null;

    // Levels are per-player (not per-team): partnerships are ad hoc every round (declarer +
    // whichever friends they call), so only an individual's own level persists meaningfully
    // across rounds. Each player starts at '2'.
    this.dealerSeat = 0; // seat that leads bidding priority / deals first round
    this.gameWonBy = null; // playerId of whoever first levels past Ace

    this.settings = {
      negativeScores: false, // see demoteLevel()/advanceLevel() for the below-'2' scoring rule
      // per-checkpoint extra wins required to pass through 5/10/K/A (0 = no extra requirement,
      // i.e. vanilla single-win advancement through that rank)
      checkpoints: { '5': 0, '10': 0, 'K': 0, 'A': 0 },
      loserSkipsBidding: false, // see determineLoserBidBlock()
      bidTimerMs: DEFAULT_BID_TIMER_MS, // 0 = no timer, else one of BID_TIMER_OPTIONS_MS
      fixedTeams: false, // even player counts only -- host-assigned, persistent partnerships
      // instead of find-a-friend; see assignPlayerTeam()/confirmTeams()
    };
    this.teamsConfirmed = false;

    this.round = null; // transient round state, see resetRoundState()
    this.log = [];
  }

  addPlayer(id, name) {
    if (this.players.find(p => p.id === id)) return;
    if (this.players.length >= 8) throw new Error('Room is full (max 8 players)');
    const seat = this.players.length;
    this.players.push({
      id, name, seat, connected: true, level: '2', levelDebt: 0, checkpointProgress: 0, loserStreak: 0,
      pendingTeam: null, fixedTeam: null,
    });
    if (!this.hostId) this.hostId = id;
    this.resetTeamAssignments(); // the roster changed -- any prior assignment/confirmation is stale
  }

  updateSettings(playerId, patch) {
    if (playerId !== this.hostId) throw new Error('Only the host can change table settings');
    if (this.phase !== 'lobby') throw new Error('Settings can only be changed before the game starts');
    if (typeof patch.negativeScores === 'boolean') this.settings.negativeScores = patch.negativeScores;
    if (typeof patch.loserSkipsBidding === 'boolean') this.settings.loserSkipsBidding = patch.loserSkipsBidding;
    if (typeof patch.fixedTeams === 'boolean') {
      this.settings.fixedTeams = patch.fixedTeams;
      this.resetTeamAssignments(); // start fresh every time the mode is toggled either way
    }
    if (patch.bidTimerMs !== undefined) {
      if (!BID_TIMER_OPTIONS_MS.includes(patch.bidTimerMs)) {
        throw new Error(`Bid timer must be one of: ${BID_TIMER_OPTIONS_MS.join(', ')} ms`);
      }
      this.settings.bidTimerMs = patch.bidTimerMs;
    }
    if (patch.checkpoints && typeof patch.checkpoints === 'object') {
      for (const rank of CHECKPOINT_RANKS) {
        const v = patch.checkpoints[rank];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v < 0 || v > MAX_CHECKPOINT_EXTRA) {
          throw new Error(`Checkpoint value for ${rank} must be an integer between 0 and ${MAX_CHECKPOINT_EXTRA}`);
        }
        this.settings.checkpoints[rank] = v;
      }
    }
  }

  // Standing for "who's in last place" purposes: primarily by rank, with checkpoint progress
  // counting as slightly ahead and level debt slightly behind others on the same bare rank.
  // Returns a tuple so ties within a rank never bleed into comparisons across different ranks.
  standingTuple(player) {
    return [RANKS.indexOf(player.level), player.checkpointProgress - player.levelDebt];
  }

  compareStandingTuples(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  }

  // Figures out whether anyone is blocked from bidding this round under the
  // "loser skips every other round" setting, and updates each player's loserStreak.
  // A player only ever gets blocked while they are the UNIQUE last-place player two (or four,
  // six, ...) rounds running; a tie for last lifts the restriction for everyone and resets streaks.
  determineLoserBidBlock() {
    if (!this.settings.loserSkipsBidding) {
      for (const p of this.players) p.loserStreak = 0;
      return null;
    }
    const tuples = this.players.map(p => this.standingTuple(p));
    let minT = tuples[0];
    for (const t of tuples) if (this.compareStandingTuples(t, minT) < 0) minT = t;
    const lowest = this.players.filter((_p, i) => this.compareStandingTuples(tuples[i], minT) === 0);

    if (lowest.length !== 1) {
      // tied for last (or everyone's tied): nobody's restricted, all streaks reset
      for (const p of this.players) p.loserStreak = 0;
      return null;
    }

    const loser = lowest[0];
    loser.loserStreak = (loser.loserStreak || 0) + 1; // continues if they were already mid-streak
    for (const p of this.players) {
      if (p.id !== loser.id) p.loserStreak = 0;
    }
    return (loser.loserStreak % 2 === 0) ? loser.id : null; // blocked on their 2nd, 4th, ... turn as sole loser
  }

  removePlayer(id) {
    const p = this.players.find(pl => pl.id === id);
    if (p) p.connected = false;
  }

  // A disconnected player (network drop, page refresh, etc.) keeps their seat, hand, level,
  // and host/declarer status under their original id — only a fresh socket connection needs to
  // be re-linked to it. server.js matches by name against currently-disconnected players to find
  // who to reconnect, then calls this to mark them live again.
  findDisconnectedByName(name) {
    return this.players.find(p => !p.connected && p.name === name);
  }

  reconnectPlayer(id) {
    const p = this.getPlayer(id);
    if (p) p.connected = true;
  }

  // Fully removes a player from the table (unlike removePlayer(), which just marks a
  // disconnected player offline so they can be seen mid-game). Only valid before the game
  // starts, so seats can just be re-numbered contiguously afterward with no round in progress
  // to disrupt.
  kickPlayer(hostId, targetId) {
    if (hostId !== this.hostId) throw new Error('Only the host can kick players');
    if (this.phase !== 'lobby') throw new Error('Players can only be kicked before the game starts');
    if (targetId === hostId) throw new Error("You can't kick yourself");
    const idx = this.players.findIndex(p => p.id === targetId);
    if (idx === -1) throw new Error('Player not found');
    const [kicked] = this.players.splice(idx, 1);
    this.players.forEach((p, i) => { p.seat = i; });
    this.resetTeamAssignments(); // the roster changed -- any prior assignment/confirmation is stale
    this.addLog(`${kicked.name} was removed from the table by the host.`);
    return kicked.id;
  }

  // ---------------- FIXED TEAMS (even player counts, host-assigned, persistent partnerships) --

  resetTeamAssignments() {
    this.teamsConfirmed = false;
    for (const p of this.players) p.pendingTeam = null;
  }

  assignPlayerTeam(hostId, targetId, team) {
    if (hostId !== this.hostId) throw new Error('Only the host can assign teams');
    if (this.phase !== 'lobby') throw new Error('Teams can only be assigned before the game starts');
    if (!this.settings.fixedTeams) throw new Error('Turn on the "set teams" option first');
    if (team !== 'A' && team !== 'B' && team !== null) throw new Error('Team must be A, B, or null');
    const target = this.getPlayer(targetId);
    if (!target) throw new Error('Player not found');
    target.pendingTeam = team;
    this.teamsConfirmed = false; // any change invalidates a previous confirmation
  }

  confirmTeams(hostId) {
    if (hostId !== this.hostId) throw new Error('Only the host can confirm teams');
    if (this.phase !== 'lobby') throw new Error('Teams can only be confirmed before the game starts');
    if (!this.settings.fixedTeams) throw new Error('Turn on the "set teams" option first');
    const n = this.players.length;
    if (n % 2 !== 0) throw new Error('Fixed teams need an even number of players');
    const teamA = this.players.filter(p => p.pendingTeam === 'A');
    const teamB = this.players.filter(p => p.pendingTeam === 'B');
    if (teamA.length + teamB.length !== n) throw new Error('Every player must be assigned to a team');
    if (teamA.length !== teamB.length) throw new Error('Both teams must have the same number of players');

    for (const p of this.players) p.fixedTeam = p.pendingTeam;
    // re-seat so partners alternate around the table (A, B, A, B, ...)
    const interleaved = [];
    for (let i = 0; i < teamA.length; i++) {
      interleaved.push(teamA[i]);
      interleaved.push(teamB[i]);
    }
    interleaved.forEach((p, i) => { p.seat = i; });
    this.players.sort((a, b) => a.seat - b.seat);
    this.teamsConfirmed = true;
    this.addLog('Teams confirmed — seats rearranged so partners alternate around the table.');
  }

  assignConfirmedFixedTeams() {
    const r = this.round;
    r.teams = {};
    const declarerFixedTeam = this.getPlayer(r.declarerId).fixedTeam;
    for (const p of this.players) {
      r.teams[p.id] = (p.fixedTeam === declarerFixedTeam) ? 'A' : 'B';
    }
    r.pendingFriendReveal = false; // teams are fixed and already known, nothing to reveal
  }

  getPlayer(id) {
    return this.players.find(p => p.id === id);
  }

  publicState(forId) {
    const me = this.getPlayer(forId);
    const base = {
      roomCode: this.roomCode,
      phase: this.phase,
      hostId: this.hostId,
      players: this.players.map(p => ({
        id: p.id, name: p.name, seat: p.seat, connected: p.connected,
        level: p.level, levelDebt: p.levelDebt, checkpointProgress: p.checkpointProgress, loserStreak: p.loserStreak,
        pendingTeam: p.pendingTeam, fixedTeam: p.fixedTeam,
      })),
      gameWonBy: this.gameWonBy,
      settings: this.settings,
      teamsConfirmed: this.teamsConfirmed,
      // generous cap: a full round's play-by-play (every card played, every trick winner) can
      // easily run several hundred lines with a large hand, so 40 would truncate mid-round
      log: this.log.slice(-1000),
    };
    if (!this.round) return base;

    const r = this.round;
    base.round = {
      numDecks: r.numDecks,
      perPlayer: r.perPlayer,
      kittySize: r.kittySize,
      levelRank: r.levelRank,
      trumpSuit: r.trumpSuit,
      bidPoints: r.bidPoints,
      declarerId: r.declarerId,
      dealerSeat: r.dealerSeat,
      bids: this.phase === 'bidding' ? undefined : r.bids,
      myBid: me ? (r.bids[me.id] ?? null) : null,
      myPassed: me ? r.bidPasses.has(me.id) : false,
      blockedBidderId: r.blockedBidderId,
      bidProgress: { acted: new Set([...Object.keys(r.bids), ...r.bidPasses]).size, total: this.players.length },
      bidDeadline: r.bidDeadline,
      bidTiebreak: r.bidTiebreak ? {
        value: r.bidTiebreak.value,
        tiedValue: r.bidTiebreak.tiedValue,
        contenders: r.bidTiebreak.contenders,
        answered: Object.keys(r.bidTiebreak.answers), // who has answered, not what they said
        deadline: r.bidTiebreak.deadline,
      } : null,
      trumpSelectDeadline: r.trumpSelectDeadline,
      kittyDeadline: r.kittyDeadline,
      friendCallDeadline: r.friendCallDeadline,
      friendsNeeded: r.friendsNeeded,
      friendCalls: r.friendCalls,
      revealedFriends: r.revealedFriends,
      teams: r.teams, // playerId -> 'A' | 'B' (A = declarer side)
      turnSeat: r.turnSeat,
      leaderSeat: r.leaderSeat,
      currentTrick: r.currentTrick, // [{seat, cards}]
      lastTrick: r.lastTrick, // previous trick's plays, shown until the next lead is played
      trickCount: r.trickCount,
      totalTricks: r.totalTricks,
      scoreA: r.scoreA, // points captured by non-declarer(challenger) side this round, conventionally tracked on team B
      lastTrickWinnerSeat: r.lastTrickWinnerSeat,
      kittyCards: (me && me.id === r.declarerId && (this.phase === 'kitty')) ? r.kitty : (r.kitty ? r.kitty.length : 0),
      finalKitty: this.phase === 'scoring' ? r.finalKittyForDisplay : undefined,
      roundResult: r.roundResult,
      myHand: me ? (r.hands[me.id] || []) : [],
      handCounts: Object.fromEntries(this.players.map(p => [p.id, (r.hands[p.id] || []).length])),
    };
    return base;
  }

  addLog(msg, opts = {}) {
    this.log.push({ t: Date.now(), msg, bold: !!opts.bold });
  }

  // ---------------- ROUND SETUP ----------------

  startRound() {
    const numPlayers = this.players.length;
    if (numPlayers < 3 || numPlayers > 8) throw new Error('Need 3-8 players');
    if (this.settings.fixedTeams && !this.teamsConfirmed) throw new Error('Confirm teams before starting the round');
    const { numDecks, perPlayer, kitty } = computeDealPlan(numPlayers);
    const shoe = shuffle(buildShoe(numDecks));

    const hands = {};
    for (const p of this.players) hands[p.id] = [];
    let idx = 0;
    for (let i = 0; i < perPlayer; i++) {
      for (const p of this.players) {
        hands[p.id].push(shoe[idx++]);
      }
    }
    const kittyCards = shoe.slice(idx, idx + kitty);

    // the level rank is the DECLARER's own level, but the declarer isn't known until bidding
    // resolves -- it gets filled in later (see finalizeDeclarer() / resolveBidding()'s no-bid
    // fallback), once we actually know who that is
    for (const p of this.players) sortHand(hands[p.id], null, null);
    this.round = {
      numDecks, perPlayer, kittySize: kitty,
      levelRank: null,
      trumpSuit: null,
      bidPoints: null,
      declarerId: null,
      dealerSeat: this.dealerSeat,
      hands,
      kitty: kittyCards,
      bids: {}, // playerId -> points, hidden from other players until bidding closes
      bidPasses: new Set(),
      blockedBidderId: null, // set below if "loser skips every other round" is on
      // null bidDeadline means no timer -- bidding only ends once everyone's bid or passed
      bidDeadline: this.settings.bidTimerMs > 0 ? Date.now() + this.settings.bidTimerMs : null,
      bidTiebreak: null, // { value, tiedValue, contenders: [id], answers: {id: bool}, deadline }
      trumpSelectDeadline: null,
      kittyDeadline: null,
      friendCallDeadline: null,
      // fixed teams are already known -- no friend-calling needed regardless of player count
      friendsNeeded: this.settings.fixedTeams ? 0 : friendsNeeded(numPlayers),
      friendCalls: [], // [{suit, rank}]
      revealedFriends: [],
      teams: null,
      turnSeat: null,
      leaderSeat: null,
      currentTrick: [],
      lastTrick: null, // snapshot of the just-finished trick, kept around for display until the next lead
      trickCount: 0,
      totalTricks: perPlayer, // each player plays perPlayer/comboSize tricks worth of cards but tracked as cards remaining
      scoreA: 0,
      // while friend identities are still unknown, trick points go to whoever won them
      // individually rather than the shared challenger total (see resolveTrick()/finalizeTeams())
      individualScores: {},
      pendingFriendReveal: false,
      capturedCards: [],
      lastTrickWinnerSeat: null,
      roundResult: null,
      finalKittyForDisplay: null,
    };
    this.phase = 'bidding';
    this.addLog(`New round dealt: ${numDecks} decks, ${perPlayer} cards each, ${kitty}-card kitty.`);

    const blockedId = this.determineLoserBidBlock();
    if (blockedId) {
      this.round.blockedBidderId = blockedId;
      this.round.bidPasses.add(blockedId); // sits this bid out automatically
      this.addLog(`${this.getPlayer(blockedId).name} is sitting out this round's bidding (last place, resting turn).`);
    }
  }

  // ---------------- BIDDING (sealed point bids, revealed once everyone's in) ----------------
  // Trump is NOT chosen here — players only bid the point value defenders must hold the
  // challengers under. Bids stay hidden from everyone (including the bidder's opponents)
  // until the window closes, at which point they're all revealed together. See chooseTrump()
  // for the follow-up step where the winning bidder actually picks a suit.

  placeBid(playerId, points) {
    const r = this.round;
    if (this.phase !== 'bidding') throw new Error('Not in bidding phase');
    if (!r.hands[playerId]) throw new Error('Not in this round');
    if (r.blockedBidderId === playerId) throw new Error("You're in last place and sitting out this round's bidding");
    if (!Number.isInteger(points) || points % BID_POINTS_STEP !== 0 || points < MIN_BID_POINTS || points > MAX_BID_POINTS) {
      throw new Error(`Bid must be a multiple of ${BID_POINTS_STEP} between ${MIN_BID_POINTS} and ${MAX_BID_POINTS}`);
    }
    r.bidPasses.delete(playerId);
    r.bids[playerId] = points;
    this.maybeResolveBidding();
  }

  passBid(playerId) {
    const r = this.round;
    if (this.phase !== 'bidding') return;
    delete r.bids[playerId];
    r.bidPasses.add(playerId);
    this.maybeResolveBidding();
  }

  biddingComplete() {
    const r = this.round;
    const acted = new Set([...Object.keys(r.bids), ...r.bidPasses]);
    return this.players.every(p => acted.has(p.id));
  }

  maybeResolveBidding() {
    if (this.biddingComplete()) this.resolveBidding();
  }

  bidWindowExpired() {
    const r = this.round;
    return this.phase === 'bidding' && r.bidDeadline !== null && Date.now() >= r.bidDeadline;
  }

  resolveBidding() {
    const r = this.round;
    const entries = Object.entries(r.bids); // [playerId, points]
    if (entries.length === 0) {
      // nobody bid: default trump is NT (joker-only trump), dealer-seat player becomes declarer by default
      r.trumpSuit = 'NT';
      r.bidPoints = DEFAULT_BID_POINTS;
      const declarer = this.players.find(p => p.seat === r.dealerSeat) || this.players[0];
      r.declarerId = declarer.id;
      r.levelRank = declarer.level;
      this.addLog(`No one bid. ${declarer.name} is the default declarer, no-trump round. Level rank is ${r.levelRank}. Defenders must hold challengers under ${r.bidPoints}.`);
      this.resortAllHandsForTrump();
      this.beginKittyPhase();
      return;
    }

    this.addLog(`Bidding revealed: ${entries.map(([id, pts]) => `${this.getPlayer(id).name} bid ${pts}`).join(', ')}.`);
    // the LOWEST bid wins: committing to hold challengers under a smaller number is the bolder,
    // more competitive claim (higher bids are the safe/conservative fallback)
    const minPoints = Math.min(...entries.map(([, pts]) => pts));
    const lowBidders = entries.filter(([, pts]) => pts === minPoints).map(([id]) => id);
    if (lowBidders.length === 1) {
      this.finalizeDeclarer(lowBidders[0], minPoints);
    } else {
      this.startBidTiebreak(lowBidders, minPoints);
    }
  }

  // ---------------- BID TIE-BREAK RUNOFF ----------------
  startBidTiebreak(contenders, tiedValue) {
    const r = this.round;
    const nextValue = tiedValue - BID_POINTS_STEP;
    if (nextValue < MIN_BID_POINTS) {
      // no room to go any lower -- coin flip immediately at the tied value
      const winner = contenders[Math.floor(Math.random() * contenders.length)];
      this.addLog(`${contenders.map(id => this.getPlayer(id).name).join(' and ')} tied at ${tiedValue} with no lower bid possible — coin flip: ${this.getPlayer(winner).name} wins.`);
      this.finalizeDeclarer(winner, tiedValue);
      return;
    }
    r.bidTiebreak = {
      value: nextValue,
      tiedValue,
      contenders: contenders.slice(),
      answers: {},
      deadline: Date.now() + BID_TIEBREAK_WINDOW_MS,
    };
    this.phase = 'bidtiebreak';
    this.addLog(`${contenders.map(id => this.getPlayer(id).name).join(' and ')} tied at ${tiedValue} points — each must say whether they'll play for ${nextValue} instead.`);
  }

  answerTiebreak(playerId, accept) {
    const r = this.round;
    if (this.phase !== 'bidtiebreak' || !r.bidTiebreak) throw new Error('Not in a bid tie-break');
    if (!r.bidTiebreak.contenders.includes(playerId)) throw new Error('You are not part of this tie-break');
    r.bidTiebreak.answers[playerId] = !!accept;
    if (Object.keys(r.bidTiebreak.answers).length === r.bidTiebreak.contenders.length) {
      this.resolveTiebreakRound();
    }
  }

  bidTiebreakWindowExpired() {
    return this.phase === 'bidtiebreak' && !!this.round.bidTiebreak && Date.now() >= this.round.bidTiebreak.deadline;
  }

  forceResolveTiebreak() {
    const r = this.round;
    if (!r.bidTiebreak) return;
    for (const id of r.bidTiebreak.contenders) {
      if (!(id in r.bidTiebreak.answers)) r.bidTiebreak.answers[id] = false; // no answer counts as "no"
    }
    this.resolveTiebreakRound();
  }

  resolveTiebreakRound() {
    const r = this.round;
    const tb = r.bidTiebreak;
    const yesPlayers = tb.contenders.filter(id => tb.answers[id] === true);
    if (yesPlayers.length === 1) {
      this.addLog(`${this.getPlayer(yesPlayers[0]).name} is the only one willing to play for ${tb.value} — they win the bid.`);
      this.finalizeDeclarer(yesPlayers[0], tb.value);
    } else if (yesPlayers.length === 0) {
      const winner = tb.contenders[Math.floor(Math.random() * tb.contenders.length)];
      this.addLog(`No one will go lower than ${tb.tiedValue} — coin flip: ${this.getPlayer(winner).name} wins.`);
      this.finalizeDeclarer(winner, tb.tiedValue);
    } else {
      this.startBidTiebreak(yesPlayers, tb.value);
    }
  }

  finalizeDeclarer(playerId, bidPoints) {
    const r = this.round;
    r.declarerId = playerId;
    r.bidPoints = bidPoints;
    r.levelRank = this.getPlayer(playerId).level;
    r.bidTiebreak = null;
    r.trumpSuit = null;
    r.trumpSelectDeadline = Date.now() + TRUMP_SELECT_WINDOW_MS;
    this.phase = 'trumpselect';
    this.addLog(`${this.getPlayer(playerId).name} wins the bid at ${bidPoints} points (level rank ${r.levelRank}) and will choose trump.`);
  }

  // ---------------- TRUMP SELECTION (declarer only, after bidding is settled) ----------------
  chooseTrump(playerId, suit) {
    const r = this.round;
    if (this.phase !== 'trumpselect') throw new Error('Not in trump selection phase');
    if (playerId !== r.declarerId) throw new Error('Only the declarer chooses trump');
    if (!['S', 'H', 'D', 'C', 'NT'].includes(suit)) throw new Error('Invalid suit');
    r.trumpSuit = suit;
    this.addLog(`${this.getPlayer(playerId).name} calls trump: ${suit === 'NT' ? 'Joker (no-trump)' : SUIT_SYMBOL[suit]}.`);
    this.resortAllHandsForTrump();
    this.beginKittyPhase();
  }

  trumpSelectWindowExpired() {
    return this.phase === 'trumpselect' && Date.now() >= this.round.trumpSelectDeadline;
  }

  // Once trump is settled, everyone's hand (not just the declarer's) gets re-sorted so jokers,
  resortAllHandsForTrump() {
    const r = this.round;
    for (const p of this.players) sortHand(r.hands[p.id], r.trumpSuit, r.levelRank);
  }

  beginKittyPhase() {
    const r = this.round;
    r.hands[r.declarerId].push(...r.kitty);
    sortHand(r.hands[r.declarerId], r.trumpSuit, r.levelRank);
    r.kittyDeadline = Date.now() + KITTY_WINDOW_MS;
    this.phase = 'kitty';
  }

  // ---------------- KITTY BURIAL ----------------

  buryKitty(playerId, cardIds) {
    const r = this.round;
    if (this.phase !== 'kitty') throw new Error('Not in kitty phase');
    if (playerId !== r.declarerId) throw new Error('Only the declarer buries the kitty');
    if (cardIds.length !== r.kittySize) throw new Error(`Must bury exactly ${r.kittySize} cards`);
    const hand = r.hands[playerId];
    const buried = [];
    for (const id of cardIds) {
      const c = hand.find(x => x.id === id);
      if (!c) throw new Error('Card not in hand');
      buried.push(c);
    }
    r.hands[playerId] = hand.filter(c => !cardIds.includes(c.id));
    r.kitty = buried; // now represents the buried bottom, will go to whoever wins the final trick
    this.addLog(`${this.getPlayer(playerId).name} buried the kitty.`);

    if (r.friendsNeeded > 0) {
      r.friendCallDeadline = Date.now() + FRIEND_CALL_WINDOW_MS;
      this.phase = 'friendcall';
    } else if (this.settings.fixedTeams) {
      this.assignConfirmedFixedTeams();
      this.beginPlay();
    } else {
      // only reachable with exactly 3 players: no friend calling, declarer plays solo
      this.assignSoloDeclarerTeam();
      this.beginPlay();
    }
  }

  // ---------------- FIND-A-FRIEND (every player count except exactly 3) ----------------

  callFriends(playerId, calls) {
    const r = this.round;
    if (this.phase !== 'friendcall') throw new Error('Not in friend-call phase');
    if (playerId !== r.declarerId) throw new Error('Only the declarer calls friends');
    if (calls.length !== r.friendsNeeded) throw new Error(`Must call exactly ${r.friendsNeeded} friend card(s)`);
    for (const c of calls) {
      if (c.suit === 'JOKER') throw new Error("Can't call a joker as a friend card");
    }
    r.friendCalls = calls;
    this.addLog(`${this.getPlayer(playerId).name} called for friends holding: ${calls.map(c => cardLabel(c)).join(', ')}`);
    this.assignFriendTeams();
    this.beginPlay();
  }

  friendCallWindowExpired() {
    return this.phase === 'friendcall' && Date.now() >= this.round.friendCallDeadline;
  }

  assignFriendTeams() {
    const r = this.round;
    r.teams = {};
    for (const p of this.players) r.teams[p.id] = 'B';
    r.teams[r.declarerId] = 'A';
    // Friends are revealed progressively as their called card is played; until then they're
    // provisionally on B, and their trick points accrue individually (see resolveTrick()) since
    // we don't yet know whether they'll turn out to be a friend.
    r.pendingFriendReveal = r.friendCalls.length > 0;
    r.individualScores = {};
  }

  assignSoloDeclarerTeam() {
    const r = this.round;
    r.teams = {};
    for (const p of this.players) {
      r.teams[p.id] = (p.id === r.declarerId) ? 'A' : 'B';
    }
    r.pendingFriendReveal = false; // no friend calls in solo mode, teams are known from the start
  }

  // Every friend call has now been claimed, so team membership for the rest of the round is
  // certain. Whatever the (still-provisional-B) players individually accrued while identities
  // were unknown now combines into the shared challenger total.
  finalizeTeams() {
    const r = this.round;
    for (const [playerId, pts] of Object.entries(r.individualScores)) {
      if (r.teams[playerId] === 'B') r.scoreA += pts;
    }
    r.individualScores = {};
    r.pendingFriendReveal = false;
    this.addLog('All friends have been revealed — teams are finalized and points are combined.');
  }

  // ---------------- TRICK PLAY ----------------

  beginPlay() {
    const r = this.round;
    r.leaderSeat = this.getPlayer(r.declarerId).seat;
    r.turnSeat = r.leaderSeat;
    r.currentTrick = [];
    this.phase = 'playing';
    this.addLog(`Play begins. ${this.getPlayer(r.declarerId).name} leads the first trick.`);
  }

  seatOrder() {
    return this.players.slice().sort((a, b) => a.seat - b.seat);
  }

  nextSeat(seat) {
    const order = this.seatOrder();
    const i = order.findIndex(p => p.seat === seat);
    return order[(i + 1) % order.length].seat;
  }

  playCards(playerId, cardIds) {
    const r = this.round;
    if (this.phase !== 'playing') throw new Error('Not in playing phase');
    const player = this.getPlayer(playerId);
    if (!player || player.seat !== r.turnSeat) throw new Error('Not your turn');
    const hand = r.hands[playerId];
    const cards = cardIds.map(id => hand.find(c => c.id === id));
    if (cards.some(c => !c)) throw new Error('Card not in hand');
    if (new Set(cardIds).size !== cardIds.length) throw new Error('Duplicate card in play');

    let actualCards = cards; 

    const isLeader = r.currentTrick.length === 0;
    if (isLeader) {
      const combo = classifyCombo(cards, r.trumpSuit, r.levelRank);
      if (combo.type === 'empty') throw new Error('Must lead at least one card');
      if (combo.type === 'mixed') {
        actualCards = this.resolveComboThrow(playerId, cards);
      }
      r.lastTrick = null; // the new trick is starting, stop showing the previous one
    } else {
      const leadCards = r.currentTrick[0].cards;
      if (cards.length !== leadCards.length) throw new Error(`Must play ${leadCards.length} card(s)`);
      const leadCombo = classifyCombo(leadCards, r.trumpSuit, r.levelRank);
      const leadGroup = leadCombo.group;
      const cardsInLeadGroup = hand.filter(c => suitGroup(c, r.trumpSuit, r.levelRank) === leadGroup);
      if (cardsInLeadGroup.length > 0) {
        const usedFromGroup = cards.filter(c => suitGroup(c, r.trumpSuit, r.levelRank) === leadGroup).length;
        const required = Math.min(cardsInLeadGroup.length, cards.length);
        if (usedFromGroup < required) {
          throw new Error(`You must follow suit: play cards from ${leadGroup === 'TRUMP' ? 'trump' : leadGroup} first`);
        }
        if (cardsInLeadGroup.length >= leadCards.length && ['pair', 'triple', 'quadruple'].includes(leadCombo.type)) {
          this.enforceShapeFollow(leadCombo, cardsInLeadGroup, cards);
        }
      }
    }

    // remove the ACTUAL cards played from hand (a failed combo throw only spends its weakest
    // card; the rest of the attempted selection stays in hand), add to trick
    const actualIds = new Set(actualCards.map(c => c.id));
    r.hands[playerId] = hand.filter(c => !actualIds.has(c.id));
    r.currentTrick.push({ seat: player.seat, playerId, cards: actualCards });
    this.addLog(`${player.name} played: ${actualCards.map(c => cardLabel(c)).join(', ')}`);

    // reveal friend if this play contains a called friend card (find-a-friend mode) and not yet revealed
    if (r.friendCalls && r.friendCalls.length && r.teams[playerId] !== 'A') {
      for (const call of r.friendCalls) {
        const already = r.revealedFriends.some(f => f.suit === call.suit && f.rank === call.rank);
        if (already) continue;
        if (actualCards.some(c => c.suit === call.suit && c.rank === call.rank)) {
          r.teams[playerId] = 'A';
          r.revealedFriends.push(call);
          this.addLog(`${player.name} revealed as a friend! (played the called ${cardLabel(call)})`);
          // they joined the defenders -- whatever they'd individually accrued is released,
          // not counted toward anyone's score
          delete r.individualScores[playerId];
          if (r.revealedFriends.length === r.friendCalls.length) {
            this.finalizeTeams();
          }
        }
      }
    }

    if (r.currentTrick.length === this.players.length) {
      this.resolveTrick();
    } else {
      r.turnSeat = this.nextSeat(r.turnSeat);
    }
  }

  // ---------------- COMBO THROWS ----------------
  resolveComboThrow(playerId, cards) {
    const r = this.round;
    const group = suitGroup(cards[0], r.trumpSuit, r.levelRank);
    if (!cards.every(c => suitGroup(c, r.trumpSuit, r.levelRank) === group)) {
      throw new Error('A combo must be all one suit (or all trump)');
    }

    // decompose the throw into same-rank chunks (a pair of Kings + a lone Ace -> two chunks)
    const chunks = {};
    for (const c of cards) {
      const k = cardKey(c);
      (chunks[k] = chunks[k] || []).push(c);
    }

    let beaten = false;
    for (const chunkCards of Object.values(chunks)) {
      const count = chunkCards.length;
      const strength = cardStrength(chunkCards[0], r.trumpSuit, r.levelRank);
      for (const p of this.players) {
        if (p.id === playerId) continue;
        const oppCounts = {};
        for (const c of r.hands[p.id]) {
          if (suitGroup(c, r.trumpSuit, r.levelRank) !== group) continue;
          oppCounts[cardKey(c)] = (oppCounts[cardKey(c)] || 0) + 1;
        }
        for (const [oppKey, oppCount] of Object.entries(oppCounts)) {
          if (oppCount < count) continue;
          const oppCard = r.hands[p.id].find(c => cardKey(c) === oppKey);
          if (cardStrength(oppCard, r.trumpSuit, r.levelRank) > strength) { beaten = true; break; }
        }
        if (beaten) break;
      }
      if (beaten) break;
    }

    if (!beaten) return cards;

    const weakest = cards.reduce((min, c) =>
      cardStrength(c, r.trumpSuit, r.levelRank) < cardStrength(min, r.trumpSuit, r.levelRank) ? c : min);
    const comboDesc = cards.map(c => cardLabel(c)).join(', ');
    this.addLog(`${this.getPlayer(playerId).name} tried to throw a combo (${comboDesc}) but it can be beaten — forced to play their smallest card instead.`);
    return [weakest];
  }

  // When following a pair/triple/quadruple lead and holding enough cards in that suit-group to
  // match its length, a player must use as much of their own matching structure as they have —
  // pairs (even ones locked inside a tractor, which must be broken apart), and triples ahead of
  // pairs when following a quadruple. This mirrors the "renege" rule: you can't hide a pair/triple
  // behind unrelated singles just because you also hold some.
  enforceShapeFollow(leadCombo, groupCardsInHand, playedCards) {
    const handCounts = {};
    for (const c of groupCardsInHand) handCounts[cardKey(c)] = (handCounts[cardKey(c)] || 0) + 1;
    const maxCountInHand = Math.max(0, ...Object.values(handCounts));
    const pairsAvailableInHand = Object.values(handCounts).reduce((s, n) => s + Math.floor(n / 2), 0);

    const playedCounts = {};
    for (const c of playedCards) playedCounts[cardKey(c)] = (playedCounts[cardKey(c)] || 0) + 1;
    const playedMaxCount = Math.max(0, ...Object.values(playedCounts));
    const playedPairs = Object.values(playedCounts).reduce((s, n) => s + Math.floor(n / 2), 0);

    if (leadCombo.type === 'pair' || leadCombo.type === 'triple') {
      if (pairsAvailableInHand >= 1 && playedPairs < 1) {
        throw new Error('You hold a pair in this suit — you must play it (breaking a tractor if that\'s your only pair)');
      }
    } else if (leadCombo.type === 'quadruple') {
      if (maxCountInHand >= 3) {
        if (playedMaxCount < 3) {
          throw new Error('You hold a triple/quadruple in this suit — you must play it');
        }
      } else {
        const requiredPairs = Math.min(2, pairsAvailableInHand);
        if (playedPairs < requiredPairs) {
          throw new Error('You must play your available pairs here (breaking tractors if that\'s where they are)');
        }
      }
    }
  }

  resolveTrick() {
    const r = this.round;
    const leadPlay = r.currentTrick[0];
    const leadCombo = classifyCombo(leadPlay.cards, r.trumpSuit, r.levelRank);
    const leadGroup = leadCombo.group;

    let winner = leadPlay;
    let winnerIsTrump = leadGroup === 'TRUMP';
    let winnerStrength = comboStrength(leadPlay.cards, r.trumpSuit, r.levelRank);

    for (const play of r.currentTrick.slice(1)) {
      const combo = classifyCombo(play.cards, r.trumpSuit, r.levelRank);
      const group = combo.group;
      const isTrumpPlay = group === 'TRUMP';
      // a play can only ever overtake the lead if it replicates the lead's exact shape
      // (single/pair/triple/quadruple/tractor of the same length) — a forced substitution
      // (e.g. a pair filling in for a triple, or a mixed discard) can never win the trick,
      // no matter how numerically strong its individual cards are
      const matchesLeadShape = combo.type === leadCombo.type && combo.type !== 'mixed';

      if (isTrumpPlay && !winnerIsTrump) {
        // any trump interrupts and beats a non-trump lead outright
        winner = play; winnerIsTrump = true; winnerStrength = comboStrength(play.cards, r.trumpSuit, r.levelRank);
      } else if (isTrumpPlay && winnerIsTrump) {
        if (!matchesLeadShape) continue;
        const s = comboStrength(play.cards, r.trumpSuit, r.levelRank);
        if (s > winnerStrength) { winner = play; winnerStrength = s; }
      } else if (!isTrumpPlay && !winnerIsTrump && group === leadGroup) {
        if (!matchesLeadShape) continue;
        const s = comboStrength(play.cards, r.trumpSuit, r.levelRank);
        if (s > winnerStrength) { winner = play; winnerStrength = s; }
      }
      // off-suit, non-trump plays (a forced discard) never contend for the win
    }

    const trickCards = r.currentTrick.flatMap(p => p.cards);
    const pts = totalPoints(trickCards);
    r.capturedCards.push(...trickCards);
    if (r.pendingFriendReveal) {
      // identities aren't settled yet: a still-provisional-B winner's points accrue to them
      // individually (combined into the shared total once all friends are revealed); a
      // confirmed-A winner's points are simply discarded, same as always for the defending side
      if (r.teams[winner.playerId] === 'B') {
        r.individualScores[winner.playerId] = (r.individualScores[winner.playerId] || 0) + pts;
      }
    } else if (r.teams[winner.playerId] === 'B') {
      r.scoreA += pts; // "scoreA" tracks the challenger (non-declarer) side's captured points, named scoreA for legacy
    }

    const winnerName = this.getPlayer(winner.playerId).name;
    this.addLog(`${winnerName} wins the trick${pts ? ` (+${pts} pts)` : ''}.`, { bold: true });

    r.lastTrickWinnerSeat = winner.seat;
    r.leaderSeat = winner.seat;
    r.turnSeat = winner.seat;
    // keep a snapshot of the just-finished trick for display purposes -- currentTrick itself
    // has to go back to empty so the next lead is correctly detected as a lead (see playCards()),
    // but the cards should visibly stay on the table until the new leader actually plays
    r.lastTrick = r.currentTrick;
    r.currentTrick = [];
    r.trickCount += 1;

    const cardsLeft = Object.values(r.hands).some(h => h.length > 0);
    if (!cardsLeft) {
      this.finishRound(winner);
    }
  }

  finishRound(lastTrickWinnerPlay) {
    const r = this.round;
    // safety net: every friend-called card is guaranteed to be played by round end (the
    // declarer can never hold or bury one), so teams should already be finalized here — but
    // reconcile defensively in case any individual points were somehow never combined
    if (r.pendingFriendReveal) this.finalizeTeams();
    const winnerTeam = r.teams[lastTrickWinnerPlay.playerId];
    const kittyPts = totalPoints(r.kitty);
    // the multiplier doubles per card in the final trick's combo: single->2x, pair->4x, triple->8x, quadruple->16x
    const kittyMultiplier = 2 ** lastTrickWinnerPlay.cards.length;
    if (winnerTeam === 'B') {
      r.scoreA += kittyPts * kittyMultiplier; // challengers win the bottom, multiplied by the last trick's shape
    }
    // if declarer's team (A) wins the last trick, the kitty points are simply discarded (defenders don't need them)

    r.finalKittyForDisplay = { cards: r.kitty, points: kittyPts, wentTo: winnerTeam, multiplier: kittyMultiplier };

    const challengerScore = r.scoreA;
    const threshold = r.bidPoints; // the declarer's bid: defenders must hold challengers under this many points
    let result;
    if (challengerScore >= threshold) {
      // challengers win: each of them personally levels up. The declarer alone is knocked back
      // one level as the penalty for losing the bid; friends (ad hoc teammates this round only)
      // are unaffected either way.
      const levelUp = 1 + Math.floor((challengerScore - threshold) / (threshold / 2));
      result = { winningSide: 'challengers', levelUp, challengerScore, threshold };
      for (const p of this.players) {
        if (r.teams[p.id] === 'B') this.advanceLevel(p.id, levelUp);
      }
      this.demoteLevel(r.declarerId);
    } else {
      // defenders successfully held: declarer and friends all level up together
      const levelUp = Math.max(1, Math.ceil((threshold - challengerScore) / (threshold / 2)));
      result = { winningSide: 'defenders', levelUp, challengerScore, threshold };
      for (const p of this.players) {
        if (r.teams[p.id] === 'A') this.advanceLevel(p.id, levelUp);
      }
      this.advanceLevel(r.declarerId)
      // defenders keep defending: dealer seat advances to declarer again (stays same declarer team lead)
    }
    r.roundResult = result;
    this.phase = 'scoring';
    this.addLog(`Round over. Challengers scored ${challengerScore} (needed ${threshold}). 
      ${result.winningSide === 'challengers' ? 'Challengers' : 'Defenders'} level up by ${result.levelUp}.
      Since ${result.winningSide === 'challengers' ? 'Challengers' : 'Defenders'} won, ${r.declarerId} gets ${result.winningSide === 'challengers' ? '-1' : '+1'}`);

    // rotate dealer seat to the next player for next round
    this.dealerSeat = this.nextSeat(this.dealerSeat);
  }

  advanceLevel(playerId, amount) {
    const order = RANKS;
    const player = this.getPlayer(playerId);
    if (player.levelDebt > 0) {
      const payoff = Math.min(amount, player.levelDebt);
      player.levelDebt -= payoff;
      amount -= payoff;
    }
    for (let i = 0; i < amount; i++) {
      const req = this.settings.checkpoints[player.level] || 0;
      if (req > 0 && player.checkpointProgress < req) {
        player.checkpointProgress += 1;
        continue;
      }
      const idx = order.indexOf(player.level) + 1;
      if (idx >= order.length) {
        player.level = 'A';
        if (!this.gameWonBy) this.gameWonBy = playerId;
        return;
      }
      player.level = order[idx];
      player.checkpointProgress = 0;
    }
  }

  //handles demotion 
  demoteLevel(playerId) {
    const order = RANKS;
    const player = this.getPlayer(playerId);
    if (player.checkpointProgress > 0) {
      player.checkpointProgress -= 1;
      return;
    }
    const idx = order.indexOf(player.level) - 1;
    if (idx >= 0) {
      player.level = order[idx];
      return;
    }
    if (this.settings.negativeScores) {
      player.levelDebt += 1;
    }
  }

  isGameOver() {
    return !!this.gameWonBy;
  }
}

// Sorts hand 
function sortHand(hand, trumpSuit, levelRank) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  hand.sort((a, b) => {
    const groupA = suitGroup(a, trumpSuit, levelRank);
    const groupB = suitGroup(b, trumpSuit, levelRank);
    if (groupA !== groupB) {
      if (groupA === 'TRUMP') return -1;
      if (groupB === 'TRUMP') return 1;
      return (suitOrder[groupA] ?? 9) - (suitOrder[groupB] ?? 9);
    }
    if (groupA === 'TRUMP') return cardStrength(b, trumpSuit, levelRank) - cardStrength(a, trumpSuit, levelRank);
    return RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank);
  });
}

module.exports = {
  Game, friendsNeeded, FRIEND_CALL_WINDOW_MS, KITTY_WINDOW_MS,
  BID_TIEBREAK_WINDOW_MS, TRUMP_SELECT_WINDOW_MS,
  MIN_BID_POINTS, MAX_BID_POINTS, BID_POINTS_STEP, DEFAULT_BID_POINTS,
  CHECKPOINT_RANKS, MAX_CHECKPOINT_EXTRA,
  BID_TIMER_OPTIONS_MS, DEFAULT_BID_TIMER_MS,
};
