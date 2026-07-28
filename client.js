const socket = io();

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);
const RANKS_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const MIN_BID_POINTS = 40;
const MAX_BID_POINTS = 200;
const BID_POINTS_STEP = 5;
const CHECKPOINT_RANKS = ['5', '10', 'K', 'A'];
const MAX_CHECKPOINT_EXTRA = 5;
const DEFENDER_ICON = '🛡️';
const CHALLENGER_ICON = '⚔️';
const JOKER_ICON = '🎭';

let myId = null;
let state = null;
let selected = new Set(); // selected card ids in hand
let friendPicks = []; // for friend-call UI local state
let bidSliderValue = null; // locally-held, not-yet-submitted bid value while the slider is being adjusted

// A refresh or brief network drop gets a brand-new socket connection, so we remember which
// table + name we were using and silently rejoin under that name — the server reconnects us
// to our original seat/hand as long as we're still marked disconnected there.
const SESSION_KEY = 'tractor_session';
function saveSession(name, roomCode) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ name, roomCode })); } catch (e) { /* ignore */ }
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}

socket.on('connect', () => {
  const session = loadSession();
  if (!session || !session.name || !session.roomCode) return;
  socket.emit('joinRoom', { name: session.name, roomCode: session.roomCode }, (res) => {
    if (!res.ok) {
      clearSession();
      showConnectError(res.error || 'Could not reconnect automatically — please rejoin.');
      return;
    }
    myId = res.playerId;
    showScreen('screen-lobby');
  });
});

// ---------------- screen helpers ----------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

function showConnectError(msg) {
  document.getElementById('connect-error').textContent = msg || '';
}

document.getElementById('btn-create').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim() || 'Player';
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return showConnectError(res.error || 'Could not create table');
    myId = res.playerId;
    saveSession(name, res.roomCode);
    showScreen('screen-lobby');
  });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim() || 'Player';
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (code.length !== 4) return showConnectError('Enter the 4-letter table code');
  socket.emit('joinRoom', { name, roomCode: code }, (res) => {
    if (!res.ok) return showConnectError(res.error || 'Could not join table');
    myId = res.playerId;
    saveSession(name, code);
    showScreen('screen-lobby');
  });
});

document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('startRound');
});

document.getElementById('setting-negative-scores').addEventListener('change', (e) => {
  socket.emit('updateSettings', { negativeScores: e.target.checked });
});

document.getElementById('setting-loser-skips-bidding').addEventListener('change', (e) => {
  socket.emit('updateSettings', { loserSkipsBidding: e.target.checked });
});

document.getElementById('setting-bid-timer').addEventListener('change', (e) => {
  socket.emit('updateSettings', { bidTimerMs: parseInt(e.target.value, 10) });
});

document.getElementById('setting-fixed-teams').addEventListener('change', (e) => {
  socket.emit('updateSettings', { fixedTeams: e.target.checked });
});

document.getElementById('btn-confirm-teams').addEventListener('click', () => {
  socket.emit('confirmTeams');
});

function confirmEndGame() {
  if (confirm('Are you sure? This will end the game for everyone.')) socket.emit('endGame');
}
document.getElementById('btn-end-game-lobby').addEventListener('click', confirmEndGame);
document.getElementById('btn-end-game').addEventListener('click', confirmEndGame);

buildCheckpointRows();
function buildCheckpointRows() {
  const container = document.getElementById('checkpoint-rows');
  CHECKPOINT_RANKS.forEach(rank => {
    const row = document.createElement('label');
    row.className = 'checkpoint-row';
    const select = document.createElement('select');
    select.id = `setting-checkpoint-${rank}`;
    for (let v = 0; v <= MAX_CHECKPOINT_EXTRA; v++) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v === 0 ? 'off' : `+${v}`;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      socket.emit('updateSettings', { checkpoints: { [rank]: parseInt(select.value, 10) } });
    });
    row.innerHTML = `<span>Checkpoint ${rank}</span>`;
    row.appendChild(select);
    container.appendChild(row);
  });
}

document.getElementById('btn-log-toggle').addEventListener('click', () => {
  document.getElementById('log-panel').classList.toggle('hidden');
});
document.getElementById('btn-log-close').addEventListener('click', () => {
  document.getElementById('log-panel').classList.add('hidden');
});

socket.on('errorMsg', (msg) => {
  flashError(msg);
});

function flashError(msg) {
  let el = document.getElementById('flash-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash-error';
    el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#9c2b2b;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;z-index:999;box-shadow:0 8px 20px rgba(0,0,0,.4);font-family:Manrope,sans-serif;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 3200);
}

socket.on('kicked', () => {
  state = null;
  clearSession();
  showScreen('screen-connect');
  showConnectError('The host removed you from the table.');
});

socket.on('gameEnded', () => {
  state = null;
  clearSession();
  showScreen('screen-connect');
  showConnectError('The host ended the game for everyone.');
});

// ---------------- state handling ----------------
socket.on('state', (s) => {
  state = s;
  selected = new Set();
  render();
});

function me() { return state.players.find(p => p.id === myId); }

function render() {
  if (!state) return;

  if (state.phase === 'lobby') {
    showScreen('screen-lobby');
    renderLobby();
    return;
  }
  if (state.phase !== 'bidding') bidSliderValue = null; // fresh slider next time bidding opens
  showScreen('screen-game');
  renderGame();
}

function renderLobby() {
  document.getElementById('lobby-code').textContent = state.roomCode;
  const isHost = myId === state.hostId;
  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  state.players.forEach((p, i) => {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('offline');
    li.innerHTML = `<span><span class="seat-num">${i + 1}.</span>${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</span>
      <span class="player-row-right"><span class="tag">${p.id === state.hostId ? 'HOST' : (p.connected ? 'READY' : 'OFFLINE')}</span></span>`;
    if (isHost && p.id !== myId) {
      const kickBtn = document.createElement('button');
      kickBtn.className = 'btn btn-ghost tiny';
      kickBtn.textContent = 'Kick';
      kickBtn.onclick = () => {
        if (confirm(`Remove ${p.name} from the table?`)) socket.emit('kickPlayer', { playerId: p.id });
      };
      li.querySelector('.player-row-right').appendChild(kickBtn);
    }
    list.appendChild(li);
  });
  const negScoresBox = document.getElementById('setting-negative-scores');
  negScoresBox.checked = !!(state.settings && state.settings.negativeScores);
  negScoresBox.disabled = !isHost;

  const checkpoints = (state.settings && state.settings.checkpoints) || {};
  CHECKPOINT_RANKS.forEach(rank => {
    const select = document.getElementById(`setting-checkpoint-${rank}`);
    select.value = checkpoints[rank] || 0;
    select.disabled = !isHost;
  });

  const loserBox = document.getElementById('setting-loser-skips-bidding');
  loserBox.checked = !!(state.settings && state.settings.loserSkipsBidding);
  loserBox.disabled = !isHost;

  const bidTimerSelect = document.getElementById('setting-bid-timer');
  bidTimerSelect.value = String((state.settings && state.settings.bidTimerMs) ?? 30000);
  bidTimerSelect.disabled = !isHost;

  const fixedTeamsOn = !!(state.settings && state.settings.fixedTeams);
  const fixedTeamsBox = document.getElementById('setting-fixed-teams');
  fixedTeamsBox.checked = fixedTeamsOn;
  fixedTeamsBox.disabled = !isHost;
  renderTeamAssignRows(isHost, fixedTeamsOn);

  const n = state.players.length;
  const btn = document.getElementById('btn-start');
  const note = document.getElementById('lobby-note');
  const teamsBlocking = fixedTeamsOn && !state.teamsConfirmed;
  if (n < 3) {
    btn.disabled = true; btn.textContent = `Waiting for players (${n}/3 minimum)`;
    note.textContent = '';
  } else if (n > 8) {
    btn.disabled = true; btn.textContent = 'Too many players (max 8)';
  } else if (teamsBlocking) {
    btn.disabled = true; btn.textContent = 'Confirm teams before starting';
    note.textContent = isHost ? 'Assign every player to Team A or Team B above, then confirm.' : 'Waiting for the host to confirm teams.';
  } else {
    btn.disabled = !isHost;
    btn.textContent = isHost ? `Start round · ${n} players` : `Waiting for host to start (${n} players)`;
    note.textContent = isHost ? '' : 'Only the host can start the round.';
  }

  document.getElementById('btn-end-game-lobby').style.display = isHost ? '' : 'none';
}

function renderTeamAssignRows(isHost, fixedTeamsOn) {
  const container = document.getElementById('team-assign-rows');
  const confirmBtn = document.getElementById('btn-confirm-teams');
  const statusEl = document.getElementById('team-assign-status');
  container.innerHTML = '';

  if (!fixedTeamsOn) {
    confirmBtn.style.display = 'none';
    statusEl.textContent = '';
    return;
  }

  const n = state.players.length;
  state.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'checkpoint-row';
    const select = document.createElement('select');
    select.disabled = !isHost;
    [['', 'Unassigned'], ['A', 'Team A'], ['B', 'Team B']].forEach(([value, label]) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      select.appendChild(o);
    });
    select.value = p.pendingTeam || '';
    select.addEventListener('change', () => {
      socket.emit('assignPlayerTeam', { playerId: p.id, team: select.value || null });
    });
    row.innerHTML = `<span>${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</span>`;
    row.appendChild(select);
    container.appendChild(row);
  });

  confirmBtn.style.display = '';
  confirmBtn.disabled = !isHost;

  if (state.teamsConfirmed) {
    statusEl.textContent = 'Teams confirmed — seats are locked in for the rest of the game.';
  } else if (n % 2 !== 0) {
    statusEl.textContent = `Need an even number of players (currently ${n}).`;
  } else {
    const assigned = state.players.filter(p => p.pendingTeam).length;
    statusEl.textContent = `${assigned} / ${n} players assigned.`;
  }
}

// ---------------- game screen ----------------
function renderGame() {
  document.getElementById('tb-code').textContent = state.roomCode;
  document.getElementById('tb-phase').textContent = phaseLabel(state.phase);
  const levelRankText = state.round
    ? (state.round.levelRank !== null ? state.round.levelRank : '?') // not known until the declarer is decided
    : (me() ? me().level : '2');
  document.getElementById('level-rank').textContent = `Level ${levelRankText}`;
  document.getElementById('my-level').textContent = `You: ${me() ? formatLevel(me()) : '2'}`;
  document.getElementById('btn-end-game').style.display = (myId === state.hostId) ? '' : 'none';

  renderLog();
  renderSeats();
  renderCenter();
  renderHandAndActions();
}

function phaseLabel(p) {
  return {
    bidding: 'Bidding',
    bidtiebreak: 'Bid runoff',
    trumpselect: 'Choosing trump',
    kitty: 'Burying the kitty',
    friendcall: 'Calling friends',
    playing: 'Playing tricks',
    scoring: 'Round complete',
  }[p] || p;
}

function renderLog() {
  const list = document.getElementById('log-list');
  const wasAtBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = '';
  (state.log || []).forEach(entry => {
    const div = document.createElement('div');
    div.className = 'entry' + (entry.bold ? ' bold' : '');
    div.textContent = entry.msg;
    list.appendChild(div);
  });
  if (wasAtBottom) list.scrollTop = list.scrollHeight;
}

function renderSeats() {
  const ring = document.getElementById('seats-ring');
  ring.innerHTML = '';
  const n = state.players.length;
  const r = state.round;
  state.players.forEach((p, i) => {
    const angle = -90 + (i * 360) / n;
    const rad = (angle * Math.PI) / 180;
    const x = 50 + 40 * Math.cos(rad);
    const y = 50 + 36 * Math.sin(rad);
    const tag = document.createElement('div');
    tag.className = 'seat-tag';
    tag.style.left = x + '%';
    tag.style.top = y + '%';
    if (r && r.teams && r.teams[p.id]) tag.classList.add('team-' + r.teams[p.id]);
    if (r && r.turnSeat === p.seat && state.phase === 'playing') tag.classList.add('turn');

    let meta = `Seat ${p.seat + 1} · Lvl ${formatLevel(p)}`;
    if (r) {
      if (p.id === r.declarerId) meta += ' · Declarer';
      if (r.teams && r.teams[p.id]) meta += r.teams[p.id] === 'A' ? ' · Def. side' : ' · Chal. side';
      if (r.handCounts && r.handCounts[p.id] !== undefined && state.phase === 'playing') meta += ` · ${r.handCounts[p.id]} cards`;
    }
    if (!p.connected) meta += ' · offline';

    const teamIcon = (r && r.teams && r.teams[p.id])
      ? `<span class="team-icon">${r.teams[p.id] === 'A' ? DEFENDER_ICON : CHALLENGER_ICON}</span>`
      : '';
    tag.innerHTML = `<div class="seat-name">${teamIcon}${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</div><div class="seat-meta">${meta}</div>`;

    if (r && state.phase === 'playing') {
      // once a trick resolves, its cards stay visible (from lastTrick) until the next trick's
      // leader actually plays -- at that point currentTrick has entries again and takes over
      const trickToShow = (r.currentTrick && r.currentTrick.length > 0) ? r.currentTrick : r.lastTrick;
      const play = trickToShow && trickToShow.find(pl => pl.seat === p.seat);
      if (play) {
        const cardsDiv = document.createElement('div');
        cardsDiv.className = 'trick-cards';
        play.cards.forEach(c => cardsDiv.appendChild(cardEl(c, { small: true, round: r })));
        tag.appendChild(cardsDiv);
      }
    }
    ring.appendChild(tag);
  });
}

function renderCenter() {
  const center = document.getElementById('table-center');
  center.innerHTML = '';
  const r = state.round;
  if (!r) { center.innerHTML = '<div class="center-panel"><p>Waiting for the round to begin…</p></div>'; return; }

  if (state.phase === 'bidding') center.appendChild(renderBiddingCenter(r));
  else if (state.phase === 'bidtiebreak') center.appendChild(renderBidTiebreakCenter(r));
  else if (state.phase === 'trumpselect') center.appendChild(renderTrumpSelectCenter(r));
  else if (state.phase === 'kitty') center.appendChild(renderKittyCenter(r));
  else if (state.phase === 'friendcall') center.appendChild(renderFriendCallCenter(r));
  else if (state.phase === 'playing') center.appendChild(renderPlayingCenter(r));
  else if (state.phase === 'scoring') center.appendChild(renderScoringCenter(r));
}

function panel(html) {
  const div = document.createElement('div');
  div.className = 'center-panel';
  div.innerHTML = html;
  return div;
}

function biddingCountdownText(r) {
  if (!r.bidDeadline) return `${r.bidProgress.acted} / ${r.bidProgress.total} players have bid · no time limit`;
  const secsLeft = Math.max(0, Math.round((r.bidDeadline - Date.now()) / 1000));
  return `${r.bidProgress.acted} / ${r.bidProgress.total} players have bid · ${secsLeft}s left`;
}

function biddingCountdownPct(r) {
  const totalMs = state.settings && state.settings.bidTimerMs;
  if (!r.bidDeadline || !totalMs) return 100;
  const secsLeft = Math.max(0, Math.round((r.bidDeadline - Date.now()) / 1000));
  return Math.max(0, Math.min(100, (secsLeft / (totalMs / 1000)) * 100));
}

function renderBiddingCenter(r) {
  if (r.blockedBidderId === myId) {
    return panel(`
      <h3>Bidding</h3>
      <p class="bid-status">You're alone in last place and sitting out this round's bidding — you'll be able to bid again next round.</p>
      <p id="bid-countdown">${biddingCountdownText(r)}</p>
      <div class="timer-bar"><div class="timer-fill" id="bid-timer-fill" style="width:${biddingCountdownPct(r)}%"></div></div>
    `);
  }

  if (bidSliderValue === null) bidSliderValue = r.myBid ?? MIN_BID_POINTS;

  const statusLine = r.myBid !== null
    ? `Your sealed bid: <b>${r.myBid}</b> pts (adjust and resubmit any time before bidding closes)`
    : (r.myPassed ? 'You passed — move the slider and submit to bid instead' : 'You haven\'t bid yet');
  const blockedNote = r.blockedBidderId ? `<p class="bid-status">${playerName(r.blockedBidderId)} is sitting out this round's bidding (last place, resting turn).</p>` : '';

  const p = panel(`
    <h3>Bidding</h3>
    <p>Bid for the <b>lowest</b> lowest number of points you can defend as the declarer. Ties are resolved in a runoff</p>
    ${blockedNote}
    <div class="bid-slider-wrap">
      <div class="bid-slider-value" id="bid-slider-value">${bidSliderValue}</div>
      <input type="range" id="bid-slider" min="${MIN_BID_POINTS}" max="${MAX_BID_POINTS}" step="${BID_POINTS_STEP}" value="${bidSliderValue}">
      <div class="bid-slider-scale"><span>${MIN_BID_POINTS}</span><span>${MAX_BID_POINTS}</span></div>
    </div>
    <div class="bid-slider-actions">
      <button id="btn-submit-bid" class="btn btn-primary">Submit bid</button>
      <button id="btn-pass-bid" class="btn btn-ghost">Pass</button>
    </div>
    <p class="bid-status">${statusLine}</p>
    <p id="bid-countdown">${biddingCountdownText(r)}</p>
    <div class="timer-bar"><div class="timer-fill" id="bid-timer-fill" style="width:${biddingCountdownPct(r)}%"></div></div>
  `);
  setTimeout(() => wireBidSlider(), 0);
  return p;
}

function wireBidSlider() {
  const slider = document.getElementById('bid-slider');
  const valueEl = document.getElementById('bid-slider-value');
  if (!slider) return;
  slider.addEventListener('input', () => {
    bidSliderValue = parseInt(slider.value, 10);
    valueEl.textContent = bidSliderValue;
  });
  document.getElementById('btn-submit-bid').onclick = () => {
    socket.emit('placeBid', { points: parseInt(slider.value, 10) });
  };
  document.getElementById('btn-pass-bid').onclick = () => {
    socket.emit('passBid');
  };
}

function bidTiebreakCountdownText(r) {
  const tb = r.bidTiebreak;
  const secsLeft = Math.max(0, Math.round((tb.deadline - Date.now()) / 1000));
  return `${tb.answered.length} / ${tb.contenders.length} have answered · ${secsLeft}s left`;
}

function renderBidTiebreakCenter(r) {
  const tb = r.bidTiebreak;
  const names = tb.contenders.map(playerName).join(' and ');
  const amIContender = tb.contenders.includes(myId);
  const iAnswered = tb.answered.includes(myId);

  let actionHtml;
  if (amIContender && !iAnswered) {
    actionHtml = `
      <p>Will you play for <b>${tb.value}</b> points instead of ${tb.tiedValue}?</p>
      <div class="bid-slider-actions">
        <button id="btn-tiebreak-yes" class="btn btn-primary">Yes, play for ${tb.value}</button>
        <button id="btn-tiebreak-no" class="btn btn-ghost">No</button>
      </div>
    `;
  } else if (amIContender && iAnswered) {
    actionHtml = `<p>Waiting on the other tied player${tb.contenders.length > 2 ? 's' : ''}…</p>`;
  } else {
    actionHtml = `<p>Watching ${names} decide.</p>`;
  }

  const p = panel(`
    <h3>Bid runoff</h3>
    <p>${names} tied at <b>${tb.tiedValue}</b> points. Whoever will still play for <b>${tb.value}</b> wins the bid there; if everyone declines, it's a coin flip at ${tb.tiedValue}.</p>
    ${actionHtml}
    <p id="bidtiebreak-countdown">${bidTiebreakCountdownText(r)}</p>
  `);
  if (amIContender && !iAnswered) {
    setTimeout(() => {
      document.getElementById('btn-tiebreak-yes').onclick = () => socket.emit('answerTiebreak', { accept: true });
      document.getElementById('btn-tiebreak-no').onclick = () => socket.emit('answerTiebreak', { accept: false });
    }, 0);
  }
  return p;
}

function trumpSelectCountdownText(r) {
  const secsLeft = Math.max(0, Math.round((r.trumpSelectDeadline - Date.now()) / 1000));
  return `${secsLeft}s left`;
}

function renderTrumpSelectCenter(r) {
  const isDeclarer = myId === r.declarerId;
  if (!isDeclarer) {
    return panel(`<h3>Choosing trump</h3><p>${playerName(r.declarerId)} won the bid at <b>${r.bidPoints}</b> points and is choosing trump.</p><p id="trumpselect-countdown">${trumpSelectCountdownText(r)}</p>`);
  }
  const p = panel(`
    <h3>Choose trump</h3>
    <p>You won the bid at <b>${r.bidPoints}</b> points. Pick the trump suit (or no-trump).</p>
    <div class="bid-slider-actions" id="trump-choices"></div>
    <p id="trumpselect-countdown">${trumpSelectCountdownText(r)}</p>
  `);
  setTimeout(() => {
    const container = document.getElementById('trump-choices');
    if (!container) return;
    ['S', 'H', 'D', 'C', 'NT'].forEach(s => {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary';
      b.textContent = suitLabel(s);
      b.onclick = () => socket.emit('chooseTrump', { suit: s });
      container.appendChild(b);
    });
  }, 0);
  return p;
}

function renderKittyCenter(r) {
  const isDeclarer = myId === r.declarerId;
  if (!isDeclarer) {
    return panel(`<h3>Burying the kitty</h3><p>${playerName(r.declarerId)} is choosing ${r.kittySize} cards to bury face-down. Trump is <b>${r.trumpSuit === 'NT' ? 'Joker' : suitLabel(r.trumpSuit)}</b>.</p>`);
  }
  return panel(`<h3>Bury the kitty</h3><p>Select exactly <b>${r.kittySize}</b> cards from your hand below, then bury them.</p><p class="kitty-hint" id="kitty-count">0 / ${r.kittySize} selected</p>`);
}

function renderFriendCallCenter(r) {
  const isDeclarer = myId === r.declarerId;
  if (!isDeclarer) {
    return panel(`<h3>Calling friends</h3><p>${playerName(r.declarerId)} is picking ${r.friendsNeeded} card(s) — whoever plays those cards first joins their team.</p>`);
  }
  const p = panel(`<h3>Call your friend card${r.friendsNeeded > 1 ? 's' : ''}</h3><p>Pick ${r.friendsNeeded} card(s) you don't hold. Whoever plays one first becomes your teammate.</p><div class="friend-picker" id="friend-picker"></div><button id="btn-submit-friends" class="btn btn-primary" style="margin-top:10px;">Confirm friend call</button>`);
  setTimeout(() => buildFriendPicker(r), 0);
  return p;
}

function buildFriendPicker(r) {
  const container = document.getElementById('friend-picker');
  if (!container) return;
  friendPicks = Array.from({ length: r.friendsNeeded }, () => ({ suit: 'S', rank: 'A' }));
  container.innerHTML = '';
  for (let i = 0; i < r.friendsNeeded; i++) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.innerHTML = `
      <span>#${i + 1}</span>
      <select data-i="${i}" data-field="rank">${RANKS_ORDER.map(rk => `<option value="${rk}">${rk}</option>`).join('')}</select>
      <select data-i="${i}" data-field="suit">${Object.keys(SUIT_SYMBOL).map(s => `<option value="${s}">${suitLabel(s)}</option>`).join('')}</select>
    `;
    container.appendChild(row);
  }
  container.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', () => {
      const i = +sel.dataset.i;
      friendPicks[i][sel.dataset.field] = sel.value;
    });
  });
  document.getElementById('btn-submit-friends').onclick = () => {
    socket.emit('callFriends', { calls: friendPicks });
  };
}

function renderPlayingCenter(r) {
  const leaderName = playerName(idBySeat(r.leaderSeat));
  return panel(`<h3>Trick ${r.trickCount + 1}</h3><p>Trump: <b>${r.trumpSuit === 'NT' ? 'Joker' : suitLabel(r.trumpSuit)}</b> · Level rank: <b>${r.levelRank}</b> · Bid: <b>${r.bidPoints}</b></p><p>${CHALLENGER_ICON} Challenger points so far: <b>${r.scoreA}</b> / ${r.bidPoints}${r.currentTrick.length === 0 ? ` · ${leaderName} leads` : ''}</p>`);
}

function renderScoringCenter(r) {
  const res = r.roundResult;
  const kitty = r.finalKitty;
  let kittyLine = '';
  if (kitty) {
    kittyLine = `<p>Bottom (${kitty.points} pts) went to the <b>${kitty.wentTo === 'A' ? `${DEFENDER_ICON} defenders` : `${CHALLENGER_ICON} challengers`}</b>${kitty.wentTo === 'B' ? ` (×${kitty.multiplier}, last trick was a ${comboSizeLabel(kitty.multiplier)})` : ''}.</p>`;
  }
  const isHost = myId === state.hostId;
  const gameOver = state.gameWonBy;

  const onSide = (side) => state.players.filter(p => r.teams && r.teams[p.id] === side);
  const levelLine = (p) => `${escapeHtml(p.name)} (${formatLevel(p)})`;
  const declarerLine = res.winningSide === 'challengers'
    ? `<p>${DEFENDER_ICON} Declarer's side: ${onSide('A').map(levelLine).join(', ')} — ${playerName(r.declarerId)} drops to <b>${formatLevel(state.players.find(p => p.id === r.declarerId))}</b>, friends unaffected.</p>`
    : `<p>${DEFENDER_ICON} Declarer's side levels up together: ${onSide('A').map(levelLine).join(', ')}.</p>`;
  const challengerLine = `<p>${CHALLENGER_ICON} Challengers: ${onSide('B').map(levelLine).join(', ')}.</p>`;

  const p = panel(`
    <h3>Round complete</h3>
    <div class="result-lines">
      <p>${CHALLENGER_ICON} Challengers captured <b>${res.challengerScore}</b> points (needed <b>${res.threshold}</b>).</p>
      <p>${res.winningSide === 'challengers' ? `${CHALLENGER_ICON} Challengers win the round` : `${DEFENDER_ICON} Defenders hold the round`} — level up by <b>${res.levelUp}</b>.</p>
      ${kittyLine}
      ${declarerLine}
      ${challengerLine}
      ${gameOver ? `<p style="color:#e8c65a;font-weight:800;">Game over — ${playerName(gameOver)} reached Ace and wins the match!</p>` : ''}
    </div>
    ${isHost ? `<button id="btn-next-round" class="btn btn-primary">${gameOver ? 'Start a new game' : 'Deal next round'}</button>` : '<p>Waiting for the host to deal the next round…</p>'}
  `);
  setTimeout(() => {
    const btn = document.getElementById('btn-next-round');
    if (btn) btn.onclick = () => socket.emit('nextRound');
  }, 0);
  return p;
}

// ---------------- hand + actions ----------------
function renderHandAndActions() {
  const handRow = document.getElementById('my-hand');
  handRow.innerHTML = '';
  const r = state.round;
  const hand = r ? (r.myHand || []) : [];
  hand.forEach(c => {
    const el = cardEl(c, { round: r, selectable: true });
    if (selected.has(c.id)) el.classList.add('selected');
    el.addEventListener('click', () => {
      if (selected.has(c.id)) selected.delete(c.id); else selected.add(c.id);
      renderHandAndActions();
      updateContextualHints();
    });
    handRow.appendChild(el);
  });

  const turnIndicator = document.getElementById('turn-indicator');
  const actions = document.getElementById('action-buttons');
  actions.innerHTML = '';
  turnIndicator.textContent = '';

  if (!r) return;

  if (state.phase === 'bidding') {
    turnIndicator.textContent = 'Use the slider above to submit your sealed bid';
  } else if (state.phase === 'bidtiebreak') {
    turnIndicator.textContent = r.bidTiebreak.contenders.includes(myId) ? 'Answer the runoff above' : 'Watching the bid runoff';
  } else if (state.phase === 'trumpselect') {
    turnIndicator.textContent = myId === r.declarerId ? 'Choose trump above' : `Waiting on ${playerName(r.declarerId)}…`;
  } else if (state.phase === 'kitty') {
    if (myId === r.declarerId) {
      turnIndicator.textContent = `Select ${r.kittySize} cards to bury`;
      const b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.disabled = selected.size !== r.kittySize;
      b.textContent = `Bury ${selected.size}/${r.kittySize}`;
      b.onclick = () => socket.emit('buryKitty', { cardIds: Array.from(selected) });
      actions.appendChild(b);
    } else {
      turnIndicator.textContent = `Waiting on ${playerName(r.declarerId)}…`;
    }
  } else if (state.phase === 'friendcall') {
    turnIndicator.textContent = myId === r.declarerId ? 'Pick your friend cards above' : `Waiting on ${playerName(r.declarerId)}…`;
  } else if (state.phase === 'playing') {
    const myTurn = me() && me().seat === r.turnSeat;
    const isLeading = r.currentTrick.length === 0;
    turnIndicator.textContent = myTurn
      ? (isLeading ? 'Your turn to lead — pick any single/pair/tractor, or throw a combo (e.g. a pair + a high card) if you\'re sure it\'s unbeatable' : 'Your turn')
      : `Waiting on ${playerName(idBySeat(r.turnSeat))}…`;
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = `Play ${selected.size || ''} card${selected.size === 1 ? '' : 's'}`;
    b.disabled = !myTurn || selected.size === 0;
    b.onclick = () => {
      socket.emit('playCards', { cardIds: Array.from(selected) });
    };
    actions.appendChild(b);
  }
}

function updateContextualHints() {
  const r = state.round;
  if (state.phase === 'kitty') {
    const el = document.getElementById('kitty-count');
    if (el) el.textContent = `${selected.size} / ${r.kittySize} selected`;
  }
}

// ---------------- rendering helpers ----------------
function cardEl(card, opts = {}) {
  const div = document.createElement('div');
  div.className = 'card' + (opts.small ? ' small' : '');
  if (card.suit === 'JOKER') {
    div.classList.add('joker');
    if (card.rank === 'BIG') div.classList.add('big');
    div.innerHTML = `<div class="rank">${card.rank === 'BIG' ? 'B' : 'S'}</div><div class="suit">${JOKER_ICON}</div>`;
  } else {
    if (RED_SUITS.has(card.suit)) div.classList.add('red');
    div.innerHTML = `<div class="rank">${card.rank}</div><div class="suit">${SUIT_SYMBOL[card.suit]}</div>`;
  }
  if (opts.round && opts.round.trumpSuit) {
    const isTrump = card.suit === 'JOKER' || card.rank === opts.round.levelRank || card.suit === opts.round.trumpSuit;
    if (isTrump) div.classList.add('trump');
  }
  return div;
}

function comboSizeLabel(multiplier) {
  return { 2: 'single', 4: 'pair', 8: 'triple', 16: 'quadruple' }[multiplier] || `${Math.round(Math.log2(multiplier))}-card combo`;
}

function formatLevel(p) {
  if (p.levelDebt > 0) return `2-${p.levelDebt}`;
  if (p.checkpointProgress > 0) return `${p.level}+${p.checkpointProgress}`;
  return p.level;
}

function suitLabel(suit) {
  return { S: 'Spades ♠', H: 'Hearts ♥', D: 'Diamonds ♦', C: 'Clubs ♣', NT: 'Joker' }[suit] || suit;
}
function playerName(id) {
  const p = state.players.find(pl => pl.id === id);
  return p ? p.name : '???';
}
function idBySeat(seat) {
  const p = state.players.find(pl => pl.seat === seat);
  return p ? p.id : null;
}
function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function tickBiddingCountdown(r) {
  const countdownEl = document.getElementById('bid-countdown');
  const fillEl = document.getElementById('bid-timer-fill');
  if (countdownEl) countdownEl.textContent = biddingCountdownText(r);
  if (fillEl) fillEl.style.width = biddingCountdownPct(r) + '%';
}
function tickTrumpSelectCountdown(r) {
  const el = document.getElementById('trumpselect-countdown');
  if (el) el.textContent = trumpSelectCountdownText(r);
}
function tickBidTiebreakCountdown(r) {
  const el = document.getElementById('bidtiebreak-countdown');
  if (el) el.textContent = bidTiebreakCountdownText(r);
}

setInterval(() => {
  if (!state || !state.round) return;
  if (state.phase === 'bidding') tickBiddingCountdown(state.round);
  else if (state.phase === 'trumpselect') tickTrumpSelectCountdown(state.round);
  else if (state.phase === 'bidtiebreak' && state.round.bidTiebreak) tickBidTiebreakCountdown(state.round);
}, 1000);

// on a small/mobile screen, start with the log panel closed -- there's no room to show it
// alongside the table, and forcing it open would just cover the game
if (window.matchMedia('(max-width: 640px)').matches) {
  document.getElementById('log-panel').classList.add('hidden');
}

showScreen('screen-connect');
