# Tractor (拖拉机) — Online Multiplayer

A real-time multiplayer web app for Tractor, for 3–8 players. One
person hosts a table, shares a 4-letter code, and everyone joins from a
browser (desktop or phone) to play together in real time.

## Run it

```bash
npm install
npm start
```

Then open `http://localhost:3000`. Anyone on your network can join at
`http://YOUR-LOCAL-IP:3000`. To let people play over the internet, deploy the
whole `tractor/` folder to any Node host (Render, Railway, Fly.io, a VPS,
etc.) — it's a single Node process with no database, so there's nothing else
to configure. Just make sure the platform exposes the port from
`process.env.PORT`.

## How a game works

1. **Host a table** → get a 4-letter code → share it. **Join a table** with
   that code from any other device. 3–8 players.
2. Host clicks **Start round** once everyone's in.
3. **Calling trump/challenging**: After cards are dealt, players all have 
    an opportunity to bid the amount of points they want to play for. 
4. **Kitty**: the winning bidder (the declarer) receives the kitty/bottom
   cards and buries the same number face-down.
5. **Calling friends** (only triggered for odd player counts — 3, 5, 7):
   the declarer names cards they *don't* hold. Whoever plays one of those
   cards first is revealed as their teammate mid-round. Everyone else is on
   the challenger side.
   For even counts (4, 6, 8) teams are fixed by alternating seats.
6. **Play**: normal trick-taking — singles, pairs, and tractors (consecutive
   same-suit pairs). Trump (the called suit + all four level-rank cards +
   both jokers) beats everything else.
7. **Scoring**: challengers try to capture 5s, 10s, and Ks. If they reach x+
   points, they win the round, take over as the defending side, and level up.
   Otherwise the defenders level up and keep defending. First side to level
   past Ace wins the match.

## Deliberate simplifications (so you know what to expect)

Full tournament Tractor rules have a lot of regional variation and edge
cases. This build implements the core structure faithfully but simplifies a
few of the fussiest bits:

- **Follow-suit enforcement** requires playing from the led suit/trump group
  when you have it, but doesn't force an exact shape match (e.g. you aren't
  required to break up a tractor to satisfy a pair if you also hold
  non-paired cards of that suit). This is the single biggest simplification.
- **Trick-winner comparison** uses each play's strongest qualifying combo
  rather than a full formal "must-beat-the-exact-shape" adjudication — it
  gets the right answer in the vast majority of real hands but isn't a
  from-first-principles reimplementation of tournament tie-break law.
- **Leveling brackets**: challengers ≥80 → they win and level up by
  `1 + floor((score-80)/40)`; otherwise defenders level up by
  `max(1, ceil((80-score)/20))`. This is one common convention — there are
  regional variants (e.g. "spring/double-kill" bonuses for shutting out the
  opponent entirely) that aren't implemented.
- Bidding/friend-call windows auto-resolve after a timer if nobody acts, so
  the game never stalls if a player goes idle.

If you want any of these tightened up to match a specific house rule set
(e.g. your family's exact variant), tell me the rule and I'll adjust the
logic in `server/Game.js` / `server/cardLogic.js`.

## Project layout

```
server/
  cardLogic.js   deck building, card strength, combo classification
  Game.js        the game state machine (bidding, kitty, teams, tricks, scoring)
  server.js      Express + Socket.io wiring, room management
public/
  index.html     app shell
  style.css      table/card visual design
  client.js      screen rendering + socket events
```

All game logic is authoritative on the server; clients only send intents
(bid, bury, call friends, play cards) and re-render from the state the
server broadcasts, so there's no way to cheat by editing the page.
