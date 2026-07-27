// cardLogic.js
// Core card representation, deck building, trump/level card strength,
// combo classification (single/pair/tractor) and trick-winner resolution.

const SUITS = ['S', 'H', 'D', 'C']; // Spades, Hearts, Diamonds, Clubs
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_INDEX = Object.fromEntries(RANKS.map((r, i) => [r, i]));

function suitName(s) {
  return { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs', JOKER: 'Joker' }[s];
}

const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };

// Human-readable label for a card, using the actual suit symbol rather than its letter
// (e.g. "A♠" instead of "AS"), for log messages and other display text.
function cardLabel(card) {
  if (card.suit === 'JOKER') return card.rank === 'BIG' ? 'Big Joker' : 'Small Joker';
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

// Build N decks of 54 cards each, tagged with a unique id.
function buildShoe(numDecks) {
  const cards = [];
  for (let d = 0; d < numDecks; d++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        cards.push({ id: `${s}${r}_${d}`, suit: s, rank: r });
      }
    }
    cards.push({ id: `JOKER_SMALL_${d}`, suit: 'JOKER', rank: 'SMALL' });
    cards.push({ id: `JOKER_BIG_${d}`, suit: 'JOKER', rank: 'BIG' });
  }
  return cards;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Decide how many decks / cards-per-player / kitty size for a given player count.
// Capped at 4 decks (enough to support up to 8 players with quadruples in play).
function computeDealPlan(numPlayers) {
  const numDecks = Math.min(4, Math.max(2, Math.ceil(numPlayers / 2)));
  const total = numDecks * 54;
  let perPlayer = Math.floor(total / numPlayers);
  let kitty = total - perPlayer * numPlayers;
  const minKitty = Math.max(4, numPlayers); // keep the kitty a reasonably meaty buffer
  while (kitty < minKitty) {
    perPlayer -= 1;
    kitty += numPlayers;
  }
  return { numDecks, perPlayer, kitty };
}

// Is this card the "level rank" card (the rank teams are currently defending), including jokers never count as level cards.
function isLevelCard(card, levelRank) {
  return card.suit !== 'JOKER' && card.rank === levelRank;
}

// Is this card a trump card given the declared trump suit ('NT' = no-trump/joker-only) and level rank.
function isTrump(card, trumpSuit, levelRank) {
  if (card.suit === 'JOKER') return true;
  if (isLevelCard(card, levelRank)) return true; // level-rank cards are trump in every suit
  if (trumpSuit !== 'NT' && card.suit === trumpSuit) return true;
  return false;
}

// Numeric strength of a single card for comparison purposes. Higher = stronger.
// Only meaningful for comparing cards that are "in contention" (same led group or both trump).
function cardStrength(card, trumpSuit, levelRank) {
  if (card.suit === 'JOKER') {
    return card.rank === 'BIG' ? 1000 : 999;
  }
  if (isLevelCard(card, levelRank)) {
    // the level-rank card in the trump suit itself outranks the level-rank card in the other 3 suits
    return card.suit === trumpSuit ? 998 : 997;
  }
  if (trumpSuit !== 'NT' && card.suit === trumpSuit) {
    return 500 + RANK_INDEX[card.rank];
  }
  // plain off-trump card, ranked only within its own suit
  return RANK_INDEX[card.rank];
}

function pointValue(card) {
  if (card.rank === '5') return 5;
  if (card.rank === '10' || card.rank === 'K') return 10;
  return 0;
}

// Group cards by "suit group": trump cards all belong to group 'TRUMP', others to their own suit.
function suitGroup(card, trumpSuit, levelRank) {
  return isTrump(card, trumpSuit, levelRank) ? 'TRUMP' : card.suit;
}

// Identity key for "is this the same card face" (rank+suit, or joker rank) — used to
// find pairs/triples/quadruples, which only exist because multiple decks are in play.
function cardKey(card) {
  return card.suit === 'JOKER' ? `J_${card.rank}` : `${card.suit}_${card.rank}`;
}

// --- Combo detection -------------------------------------------------------
const COMBO_LABEL_BY_COUNT = { 2: 'pair', 3: 'triple', 4: 'quadruple' };

function classifyCombo(cards, trumpSuit, levelRank) {
  if (cards.length === 0) return { type: 'empty' };
  if (cards.length === 1) return { type: 'single', group: suitGroup(cards[0], trumpSuit, levelRank), length: 1 };

  // group by identical card "key" (rank+suit, jokers by rank) to find pairs/triples/quadruples
  const counts = {};
  for (const c of cards) counts[cardKey(c)] = (counts[cardKey(c)] || 0) + 1;
  const keys = Object.keys(counts);

  // every card identical (up to 4 copies possible with up to 4 decks) -> pair/triple/quadruple
  if (keys.length === 1 && counts[keys[0]] === cards.length && COMBO_LABEL_BY_COUNT[cards.length]) {
    return {
      type: COMBO_LABEL_BY_COUNT[cards.length],
      group: suitGroup(cards[0], trumpSuit, levelRank),
      strength: cardStrength(cards[0], trumpSuit, levelRank),
      length: cards.length,
    };
  }

  // even count, all pairs, same suit-group, consecutive strengths -> tractor
  if (cards.length % 2 === 0 && keys.length === cards.length / 2 && keys.every(k => counts[k] === 2)) {
    const group = suitGroup(cards[0], trumpSuit, levelRank);
    const sameGroup = cards.every(c => suitGroup(c, trumpSuit, levelRank) === group);
    if (sameGroup) {
      const strengths = keys.map(k => {
        const c = cards.find(cc => cardKey(cc) === k);
        return cardStrength(c, trumpSuit, levelRank);
      }).sort((a, b) => a - b);
      let consecutive = true;
      for (let i = 1; i < strengths.length; i++) {
        if (strengths[i] !== strengths[i - 1] + 1) { consecutive = false; break; }
      }
      // jokers can't chain into a tractor with rank cards; guard: strengths must all be >=500 range consistently
      if (consecutive) {
        return { type: 'tractor', group, strength: Math.max(...strengths), length: strengths.length };
      }
    }
  }

  return { type: 'mixed', group: suitGroup(cards[0], trumpSuit, levelRank) };
}

// Compare two combos of the SAME shape (used to rank plays within a trick).
function comboStrength(cards, trumpSuit, levelRank) {
  const c = classifyCombo(cards, trumpSuit, levelRank);
  if (c.type === 'single') return cardStrength(cards[0], trumpSuit, levelRank);
  if (c.type === 'pair' || c.type === 'triple' || c.type === 'quadruple') return c.strength;
  if (c.type === 'tractor') return c.strength;

  return Math.max(...cards.map(x => cardStrength(x, trumpSuit, levelRank)));
}

function totalPoints(cards) {
  return cards.reduce((s, c) => s + pointValue(c), 0);
}

module.exports = {
  SUITS, RANKS, RANK_INDEX,
  suitName,
  SUIT_SYMBOL,
  cardLabel,
  buildShoe,
  shuffle,
  computeDealPlan,
  isLevelCard,
  isTrump,
  cardStrength,
  pointValue,
  suitGroup,
  cardKey,
  classifyCombo,
  comboStrength,
  totalPoints,
};
