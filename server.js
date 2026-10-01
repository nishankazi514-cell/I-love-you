'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

/* ============ DATABASE ============ */
let DB;
try {
  const Database = require('better-sqlite3');
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(path.join(dir, 'teenpatti.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT 'A',
      balance INTEGER NOT NULL DEFAULT 5000,
      level INTEGER NOT NULL DEFAULT 1,
      games_played INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL,
      winner_user_id INTEGER,
      winner_name TEXT,
      winning_hand TEXT,
      pot INTEGER NOT NULL,
      players TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const st = {
    insU: sqlite.prepare('INSERT INTO users (token,name,avatar,balance,level,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'),
    byT: sqlite.prepare('SELECT * FROM users WHERE token=?'),
    byI: sqlite.prepare('SELECT * FROM users WHERE id=?'),
    upP: sqlite.prepare('UPDATE users SET name=?, avatar=?, updated_at=? WHERE id=?'),
    upB: sqlite.prepare('UPDATE users SET balance=?, updated_at=? WHERE id=?'),
    rcR: sqlite.prepare('UPDATE users SET games_played=games_played+1, wins=wins+?, balance=?, updated_at=? WHERE id=?'),
    inH: sqlite.prepare('INSERT INTO game_history (round_id,winner_user_id,winner_name,winning_hand,pot,players,created_at) VALUES (?,?,?,?,?,?,?)'),
    reH: sqlite.prepare('SELECT * FROM game_history ORDER BY created_at DESC LIMIT ?'),
    top: sqlite.prepare('SELECT name,avatar,level,balance,wins,games_played FROM users ORDER BY wins DESC, balance DESC LIMIT ?')
  };
  const n = () => Date.now();
  DB = {
    kind: 'sqlite',
    createOrGetUser(t, name, av) {
      const ex = st.byT.get(t); if (ex) return ex;
      const i = st.insU.run(t, String(name || 'Player').slice(0, 20), String(av || 'A').slice(0, 4), 5000, 1, n(), n());
      return st.byI.get(i.lastInsertRowid);
    },
    getUserById: id => st.byI.get(id),
    updateProfile(id, name, av) { st.upP.run(String(name || 'Player').slice(0, 20), String(av || 'A').slice(0, 4), n(), id); return st.byI.get(id); },
    setBalance(id, b) { const s = Math.max(0, Math.floor(b)); st.upB.run(s, n(), id); return s; },
    recordResult(id, b, w) { st.rcR.run(w ? 1 : 0, Math.max(0, Math.floor(b)), n(), id); },
    saveHistory(rid, wu, wn, h, p, pl) { st.inH.run(rid, wu || null, wn || 'None', h || 'None', Math.max(0, Math.floor(p)), JSON.stringify(pl || []), n()); },
    recentHistory(l) { return st.reH.all(Math.min(l || 20, 100)); },
    topPlayers(l) { return st.top.all(Math.min(l || 10, 50)); }
  };
} catch (e) {
  console.warn('[db] sqlite unavailable, JSON fallback:', e.message);
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'teenpatti.json');
  let store = { users: [], history: [], nextU: 1, nextH: 1 };
  try { if (fs.existsSync(file)) store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  let st;
  const save = () => { clearTimeout(st); st = setTimeout(() => { try { fs.writeFileSync(file, JSON.stringify(store)); } catch (_) {} }, 200); };
  const n = () => Date.now();
  DB = {
    kind: 'json',
    createOrGetUser(t, name, av) {
      let u = store.users.find(x => x.token === t); if (u) return u;
      u = { id: store.nextU++, token: t, name: String(name || 'Player').slice(0, 20), avatar: String(av || 'A').slice(0, 4), balance: 5000, level: 1, games_played: 0, wins: 0, created_at: n(), updated_at: n() };
      store.users.push(u); save(); return u;
    },
    getUserById: id => store.users.find(u => u.id === id),
    updateProfile(id, name, av) { const u = store.users.find(x => x.id === id); if (!u) return null; u.name = String(name || 'Player').slice(0, 20); u.avatar = String(av || 'A').slice(0, 4); u.updated_at = n(); save(); return u; },
    setBalance(id, b) { const u = store.users.find(x => x.id === id); if (!u) return 0; u.balance = Math.max(0, Math.floor(b)); u.updated_at = n(); save(); return u.balance; },
    recordResult(id, b, w) { const u = store.users.find(x => x.id === id); if (!u) return; u.games_played++; if (w) u.wins++; u.balance = Math.max(0, Math.floor(b)); u.updated_at = n(); save(); },
    saveHistory(rid, wu, wn, h, p, pl) { store.history.unshift({ id: store.nextH++, round_id: rid, winner_user_id: wu || null, winner_name: wn || 'None', winning_hand: h || 'None', pot: Math.max(0, Math.floor(p)), players: JSON.stringify(pl || []), created_at: n() }); if (store.history.length > 500) store.history.length = 500; save(); },
    recentHistory(l) { return store.history.slice(0, Math.min(l || 20, 100)); },
    topPlayers(l) { return [...store.users].sort((a, b) => b.wins - a.wins || b.balance - a.balance).slice(0, Math.min(l || 10, 50)).map(u => ({ name: u.name, avatar: u.avatar, level: u.level, balance: u.balance, wins: u.wins, games_played: u.games_played })); }
  };
}

/* ============ GAME LOGIC ============ */
const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '\u2660', H: '\u2665', D: '\u2666', C: '\u2663' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rv = r => RANKS.indexOf(r) + 2;

function createDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, symbol: SUIT_SYM[s] });
  return d;
}
function shuffleDeck(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function evaluateHand(cards) {
  if (!cards || cards.length !== 3) return { category: 0, categoryName: 'High Card', score: 0 };
  const s = cards.slice().sort((a, b) => rv(b.rank) - rv(a.rank));
  const v = s.map(c => rv(c.rank));
  const same = s.every(c => c.suit === s[0].suit);
  const trail = v[0] === v[1] && v[1] === v[2];
  let seq = false;
  if (v[0] - 1 === v[1] && v[1] - 1 === v[2]) seq = true;
  if (!seq && v[0] === 14 && v[1] === 3 && v[2] === 2) seq = true;
  let cat, name;
  if (trail) { cat = 6; name = 'Trail'; }
  else if (seq && same) { cat = 5; name = 'Pure Sequence'; }
  else if (seq) { cat = 4; name = 'Sequence'; }
  else if (same) { cat = 3; name = 'Color'; }
  else if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) { cat = 2; name = 'Pair'; }
  else { cat = 1; name = 'High Card'; }
  let tb = v.slice();
  if (cat === 2) {
    let p, k;
    if (v[0] === v[1]) { p = v[0]; k = v[2]; }
    else if (v[1] === v[2]) { p = v[1]; k = v[0]; }
    else { p = v[0]; k = v[1]; }
    tb = [p, k];
  } else if (cat === 6) tb = [v[0]];
  const score = cat * 1000000 + tb.reduce((a, x, i) => a + x * Math.pow(15, tb.length - i), 0);
  return { category: cat, categoryName: name, score };
}
function compareHands(a, b) { return evaluateHand(a).score - evaluateHand(b).score; }

/* ============ SERVER ============ */
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const app = express();
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (_, res) => res.json({
  status: 'ok',
  uptime: Math.floor(process.uptime()),
  players: connectedCount(),
  seated: seatedPlayers().length,
  phase: table.phase,
  deckCount: table.deck.length,
  db: DB.kind,
  time: Date.now()
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ============ STATE ============ */
const TURN_MS = 20000;
const MIN_PLAYERS = 2;
const BASE_BET = 100;
const SEATS = [0, 1, 2, 3];

const table = {
  phase: 'waiting',
  players: [],
  deck: [],
  pot: 0,
  currentStake: BASE_BET,
  turnSeat: -1,
  turnDeadline: 0,
  roundId: null,
  sideShowRequest: null,
  handResults: [],
  winnerInfo: null,
  turnTimer: null,
  dealTimer: null,
  nextRoundTimer: null,
  chaalCount: 0,
  log: []
};

/* ============ HELPERS ============ */
function pushLog(ev) { table.log.push(Object.assign({}, ev, { ts: Date.now() })); if (table.log.length > 60) table.log.shift(); }
function connectedCount() { return table.players.filter(p => p.connected).length; }
function seatedPlayers() { return table.players.filter(p => p.seat >= 0); }
function activePlayers() { return seatedPlayers().filter(p => !p.packed); }
function seatAvailable() {
  const used = new Set(seatedPlayers().map(p => p.seat));
  for (const s of SEATS) if (!used.has(s)) return s;
  return -1;
}
function bySeat(seat) { return table.players.find(p => p.seat === seat); }
function byToken(t) { return table.players.find(p => p.token === t); }

function send(ws, type, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify({ type: type, payload: payload })); } catch (_) {}
}
function broadcast(type, payload) {
  const m = JSON.stringify({ type: type, payload: payload });
  for (const p of table.players) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) {
      try { p.ws.send(m); } catch (_) {}
    }
  }
}

function seatPublic(p) {
  return {
    userId: p.userId, name: p.name, avatar: p.avatar, level: p.level, seat: p.seat,
    balance: p.balance, packed: !!p.packed, connected: !!p.connected,
    seenCards: !!p.seenCards, revealed: !!p.revealed
  };
}

function sendStateToAll() {
  const revealAll = table.phase === 'showdown' || table.phase === 'finished';
  const base = {
    phase: table.phase,
    pot: table.pot,
    currentStake: table.currentStake,
    turnSeat: table.turnSeat,
    turnDeadline: table.turnDeadline,
    serverNow: Date.now(),
    deckCount: table.deck.length,
    sideShowRequest: table.sideShowRequest,
    winner: table.winnerInfo,
    handResults: table.handResults,
    roundId: table.roundId
  };
  for (const p of table.players) {
    if (!p.ws || p.ws.readyState !== p.ws.OPEN) continue;
    const state = Object.assign({}, base, { players: [] });
    for (const sp of seatedPlayers()) {
      const other = bySeat(sp.seat);
      let cards = null;
      if (other) {
        if (p.seat === sp.seat) {
          cards = (other.seenCards || revealAll) ? other.cards : other.cards.map(() => ({ hidden: true }));
        } else if (revealAll && other.revealed) {
          cards = other.cards;
        } else {
          cards = other.cards.length ? other.cards.map(() => ({ hidden: true })) : null;
        }
      }
      state.players.push(Object.assign({}, seatPublic(sp), { cards: cards }));
    }
    state.you = {
      userId: p.userId, seat: p.seat, balance: p.balance,
      cards: p.cards, seenCards: p.seenCards, packed: p.packed,
      canAct: table.phase === 'playing' && table.turnSeat === p.seat && !p.packed
    };
    send(p.ws, 'state', state);
  }
}

/* ============ ROUND LIFECYCLE ============ */
function clearTimers() {
  if (table.turnTimer) { clearTimeout(table.turnTimer); table.turnTimer = null; }
  if (table.dealTimer) { clearTimeout(table.dealTimer); table.dealTimer = null; }
  if (table.nextRoundTimer) { clearTimeout(table.nextRoundTimer); table.nextRoundTimer = null; }
}

function startRoundIfPossible() {
  const s = seatedPlayers().filter(p => p.connected);
  if (s.length < MIN_PLAYERS) {
    table.phase = 'waiting';
    sendStateToAll();
    return;
  }
  startRound();
}

function startRound() {
  clearTimers();
  table.roundId = crypto.randomBytes(8).toString('hex');
  table.phase = 'starting';
  table.pot = 0;
  table.currentStake = BASE_BET;
  table.chaalCount = 0;
  table.winnerInfo = null;
  table.handResults = [];
  table.sideShowRequest = null;

  for (const p of seatedPlayers()) {
    p.packed = false; p.seenCards = false; p.cards = []; p.revealed = false;
    if (p.balance < BASE_BET * 5) {
      p.balance = BASE_BET * 10;
      DB.setBalance(p.userId, p.balance);
    }
  }

  table.deck = shuffleDeck(createDeck());
  pushLog({ kind: 'round', text: 'Round starting' });
  broadcast('sfx', { sound: 'roundstart' });
  broadcast('shuffle', { deckCount: table.deck.length });
  sendStateToAll();

  const sorted = seatedPlayers().slice().sort((a, b) => a.seat - b.seat);
  const seq = [];
  for (let c = 0; c < 3; c++) for (const p of sorted) seq.push({ seat: p.seat, cardIdx: c });

  table.phase = 'dealing';
  let i = 0;
  const dealNext = () => {
    if (i >= seq.length) {
      table.phase = 'playing';
      table.currentStake = BASE_BET;
      table.turnSeat = sorted[0].seat;
      broadcast('phase', { phase: 'playing' });
      resetTurnTimer();
      sendStateToAll();
      return;
    }
    const step = seq[i++];
    const pl = bySeat(step.seat);
    if (!pl) { dealNext(); return; }
    const card = table.deck.pop();
    if (!card) { dealNext(); return; }
    pl.cards.push(card);
    broadcast('deal', { seat: step.seat, cardIdx: step.cardIdx, deckCount: table.deck.length });
    if (pl.ws && pl.ws.readyState === pl.ws.OPEN) send(pl.ws, 'private_card', { card: card, cardIdx: step.cardIdx });
    sendStateToAll();
    table.dealTimer = setTimeout(dealNext, 220);
  };
  table.dealTimer = setTimeout(dealNext, 400);
}

function nextActiveSeatAfter(seat) {
  const act = activePlayers().map(p => p.seat).sort((a, b) => a - b);
  if (!act.length) return -1;
  for (const s of act) if (s > seat) return s;
  return act[0];
}

function resetTurnTimer() {
  if (table.turnTimer) clearTimeout(table.turnTimer);
  table.turnDeadline = Date.now() + TURN_MS;
  table.turnTimer = setTimeout(handleTurnTimeout, TURN_MS + 50);
  broadcast('turn', { turnSeat: table.turnSeat, turnDeadline: table.turnDeadline, serverNow: Date.now() });
}

function handleTurnTimeout() {
  if (table.phase !== 'playing') return;
  const p = bySeat(table.turnSeat);
  if (!p) { advanceTurn(); return; }
  pushLog({ kind: 'action', text: p.name + ' auto-packed (timeout)' });
  doPack(p);
}

function doPack(p) {
  if (p.packed) return;
  p.packed = true;
  broadcast('sfx', { sound: 'pack', seat: p.seat });
  pushLog({ kind: 'action', text: p.name + ' packed' });
  sendStateToAll();
  advanceTurn();
}

function advanceTurn() {
  const act = activePlayers();
  if (act.length <= 1) {
    if (act.length === 1) endRound(act[0], null, 'Others packed');
    else { table.phase = 'waiting'; clearTimers(); sendStateToAll(); scheduleNextRound(2500); }
    return;
  }
  if (table.chaalCount > 40) { resolveShowdown(); return; }
  table.turnSeat = nextActiveSeatAfter(table.turnSeat);
  resetTurnTimer();
  sendStateToAll();
}

function scheduleNextRound(delay) {
  table.nextRoundTimer = setTimeout(() => {
    if (table.phase === 'waiting' || table.phase === 'finished') startRoundIfPossible();
  }, delay || 5000);
}

/* ============ ACTIONS ============ */
function handleAction(ws, player, action, payload) {
  if (!player) return;
  if (action === 'ping') { send(ws, 'pong', { t: Date.now() }); return; }

  if (action === 'sit') {
    if (player.seat >= 0) return;
    const seat = seatAvailable();
    if (seat < 0) { send(ws, 'error', { code: 'table_full' }); return; }
    player.seat = seat;
    player.packed = false; player.cards = []; player.seenCards = false; player.revealed = false;
    pushLog({ kind: 'join', text: player.name + ' joined the table' });
    broadcast('sfx', { sound: 'join' });
    broadcast('player_joined', { seat: seat, name: player.name });
    sendStateToAll();
    if (table.phase === 'waiting' || table.phase === 'finished') startRoundIfPossible();
    return;
  }

  if (action === 'set_profile') {
    const name = String((payload && payload.name) || '').slice(0, 20);
    const avatar = String((payload && payload.avatar) || 'A').slice(0, 4);
    if (name) {
      const u = DB.updateProfile(player.userId, name, avatar);
      if (u) { player.name = u.name; player.avatar = u.avatar; }
      sendStateToAll();
    }
    return;
  }

  if (action === 'chat') {
    const text = String((payload && payload.text) || '').slice(0, 200).trim();
    if (!text) return;
    const t = Date.now();
    if (player._lastChat && t - player._lastChat < 800) return;
    player._lastChat = t;
    broadcast('chat', { userId: player.userId, name: player.name, avatar: player.avatar, text: text, ts: t });
    return;
  }

  if (action === 'emoji') {
    const e = String((payload && payload.emoji) || '').slice(0, 8);
    if (!e) return;
    broadcast('emoji', { seat: player.seat, emoji: e, name: player.name, ts: Date.now() });
    return;
  }

  if (action === 'leave_table') { leaveTable(player); sendStateToAll(); return; }

  if (table.phase !== 'playing') return;
  if (player.seat < 0) return;
  if (table.turnSeat !== player.seat) { send(ws, 'error', { code: 'not_your_turn' }); return; }
  if (player.packed) { send(ws, 'error', { code: 'packed' }); return; }

  if (action === 'see_cards') {
    player.seenCards = true;
    send(ws, 'see_cards', { cards: player.cards });
    sendStateToAll();
    return;
  }
  if (action === 'pack') { doPack(player); return; }

  if (action === 'chaal' || action === 'chaal_2x') {
    const seen = player.seenCards;
    let amt = table.currentStake;
    if (seen) amt *= 2;
    if (action === 'chaal_2x') amt *= 2;
    if (player.balance < amt) { send(ws, 'error', { code: 'insufficient' }); doPack(player); return; }
    player.balance -= amt;
    table.pot += amt;
    DB.setBalance(player.userId, player.balance);
    if (action === 'chaal_2x') table.currentStake = amt / (seen ? 2 : 1);
    table.chaalCount++;
    broadcast('chips', { seat: player.seat, amount: amt });
    broadcast('sfx', { sound: action === 'chaal_2x' ? 'chaal2x' : 'chaal', seat: player.seat });
    pushLog({ kind: 'action', text: player.name + ' ' + (action === 'chaal_2x' ? '2x Chaal' : 'Chaal') + ' ' + amt });
    sendStateToAll();
    advanceTurn();
    return;
  }

  if (action === 'side_show') {
    const act = activePlayers();
    if (act.length < 3) { send(ws, 'error', { code: 'sideshow_unavailable' }); return; }
    const targetSeat = nextActiveSeatAfter(player.seat);
    if (targetSeat < 0 || targetSeat === player.seat) { send(ws, 'error', { code: 'sideshow_unavailable' }); return; }
    const target = bySeat(targetSeat);
    table.sideShowRequest = {
      fromSeat: player.seat, fromName: player.name,
      toSeat: targetSeat, toName: target ? target.name : '',
      expires: Date.now() + 10000
    };
    broadcast('side_show_request', table.sideShowRequest);
    broadcast('sfx', { sound: 'sideshow' });
    pushLog({ kind: 'action', text: player.name + ' requests Side Show with ' + (target ? target.name : '') });
    sendStateToAll();
    const req = table.sideShowRequest;
    setTimeout(() => {
      if (table.sideShowRequest === req) {
        table.sideShowRequest = null;
        broadcast('side_show_resolved', { accepted: false, reason: 'timeout' });
        sendStateToAll();
      }
    }, 10000);
    return;
  }

  if (action === 'side_show_response') {
    const req = table.sideShowRequest;
    if (!req || req.toSeat !== player.seat) return;
    const accepted = !!(payload && payload.accept);
    table.sideShowRequest = null;
    if (!accepted) { broadcast('side_show_resolved', { accepted: false }); sendStateToAll(); return; }
    const from = bySeat(req.fromSeat);
    if (!from || from.packed || player.packed) {
      broadcast('side_show_resolved', { accepted: false, reason: 'invalid' });
      sendStateToAll(); return;
    }
    const cmp = compareHands(from.cards, player.cards);
    const loser = cmp > 0 ? player : (cmp < 0 ? from : player);
    loser.packed = true;
    from.revealed = true; player.revealed = true;
    broadcast('side_show_resolved', {
      accepted: true,
      winnerSeat: loser.seat === from.seat ? player.seat : from.seat,
      loserSeat: loser.seat,
      reveal: [{ seat: from.seat, cards: from.cards }, { seat: player.seat, cards: player.cards }]
    });
    broadcast('sfx', { sound: 'show' });
    pushLog({ kind: 'action', text: 'Side Show: ' + loser.name + ' packed' });
    sendStateToAll();
    advanceTurn();
    return;
  }

  if (action === 'show') {
    if (activePlayers().length < 2) { send(ws, 'error', { code: 'show_unavailable' }); return; }
    player.revealed = true;
    resolveShowdown();
    return;
  }
}

function resolveShowdown() {
  table.phase = 'showdown';
  clearTimers();
  const act = activePlayers();
  for (const p of act) p.revealed = true;

  const results = act.map(p => {
    const ev = evaluateHand(p.cards);
    return { seat: p.seat, userId: p.userId, name: p.name, cards: p.cards, categoryName: ev.categoryName, score: ev.score };
  });
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  const tied = results.filter(r => r.score === best.score);
  const share = Math.floor(table.pot / tied.length);

  table.handResults = results.map(r => ({ seat: r.seat, name: r.name, cards: r.cards, category: r.categoryName, score: r.score }));

  for (const t of tied) {
    const p = bySeat(t.seat);
    if (!p) continue;
    p.balance += share;
    DB.setBalance(p.userId, p.balance);
    DB.recordResult(p.userId, p.balance, true);
  }
  for (const r of results) {
    if (tied.find(t => t.seat === r.seat)) continue;
    const p = bySeat(r.seat);
    if (p) DB.recordResult(p.userId, p.balance, false);
  }
  for (const p of seatedPlayers()) {
    if (!results.find(r => r.seat === p.seat)) DB.recordResult(p.userId, p.balance, false);
  }

  const names = tied.map(t => t.name).join(', ');
  table.winnerInfo = {
    seats: tied.map(t => t.seat),
    names: names,
    handName: best.categoryName,
    pot: table.pot,
    potShare: share
  };

  DB.saveHistory(table.roundId, tied.length === 1 ? tied[0].userId : null, names, best.categoryName, table.pot,
    seatedPlayers().map(p => ({ name: p.name, seat: p.seat })));

  broadcast('sfx', { sound: 'winner' });
  broadcast('showdown', { results: table.handResults, winner: table.winnerInfo });
  pushLog({ kind: 'result', text: names + ' won ' + table.pot + ' (' + best.categoryName + ')' });

  table.phase = 'finished';
  sendStateToAll();
  scheduleNextRound(6500);
}

function endRound(winner, hand, reason) {
  if (winner) {
    winner.balance += table.pot;
    DB.setBalance(winner.userId, winner.balance);
    DB.recordResult(winner.userId, winner.balance, true);
    for (const o of seatedPlayers()) if (o.seat !== winner.seat) DB.recordResult(o.userId, o.balance, false);
    table.winnerInfo = { seats: [winner.seat], names: winner.name, handName: hand || reason || 'Win', pot: table.pot, potShare: table.pot };
    broadcast('sfx', { sound: 'winner' });
    pushLog({ kind: 'result', text: winner.name + ' won ' + table.pot + ' (' + reason + ')' });
    DB.saveHistory(table.roundId, winner.userId, winner.name, reason || 'Win', table.pot,
      seatedPlayers().map(p => ({ name: p.name, seat: p.seat })));
  } else {
    table.winnerInfo = { seats: [], names: '', handName: '', pot: table.pot, potShare: 0 };
  }
  table.phase = 'finished';
  sendStateToAll();
  scheduleNextRound(5000);
}

function leaveTable(player) {
  if (!player) return;
  if (player.ws && player.ws.readyState === player.ws.OPEN) {
    try { send(player.ws, 'left_table', {}); } catch (_) {}
  }
  const idx = table.players.indexOf(player);
  if (idx >= 0) table.players.splice(idx, 1);
  pushLog({ kind: 'leave', text: player.name + ' left the table' });
  broadcast('sfx', { sound: 'leave' });
  broadcast('player_left', { seat: player.seat, name: player.name });
  if (table.phase === 'playing' && table.turnSeat === player.seat) advanceTurn();
  if (table.phase === 'playing' && activePlayers().length <= 1) {
    const a = activePlayers();
    if (a.length === 1) endRound(a[0], null, 'Others left');
    else { table.phase = 'waiting'; clearTimers(); scheduleNextRound(3000); }
  }
}

/* ============ WS CONNECTION ============ */
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { send(ws, 'error', { code: 'bad_json' }); return; }
    const type = msg && msg.type;
    const payload = msg && msg.payload;
    try {
      if (type === 'hello') {
        const token = String((payload && payload.token) || '').slice(0, 64);
        const name = String((payload && payload.name) || 'Player').slice(0, 20);
        const avatar = String((payload && payload.avatar) || 'A').slice(0, 4);
        if (!token) { send(ws, 'error', { code: 'no_token' }); return; }
        const user = DB.createOrGetUser(token, name, avatar);
        const existing = byToken(token);
        if (existing && existing.ws && existing.ws !== ws) {
          try { existing.ws.close(); } catch (_) {}
        }
        if (existing) {
          existing.ws = ws; existing.connected = true;
          existing.name = user.name; existing.avatar = user.avatar;
          existing.balance = user.balance; existing.level = user.level;
          player = existing;
        } else {
          player = {
            userId: user.id, token: user.token, name: user.name, avatar: user.avatar,
            level: user.level, seat: -1, balance: user.balance, cards: [],
            packed: false, seenCards: false, revealed: false, connected: true, ws: ws
          };
          table.players.push(player);
        }
        send(ws, 'hello_ok', {
          userId: user.id, name: user.name, avatar: user.avatar,
          balance: user.balance, level: user.level,
          gamesPlayed: user.games_played, wins: user.wins, seat: player.seat
        });
        send(ws, 'log_history', { log: table.log.slice(-25) });
        sendStateToAll();
        return;
      }
      if (!player) { send(ws, 'error', { code: 'not_authenticated' }); return; }
      if (type === 'action') handleAction(ws, player, payload && payload.action, payload);
      else if (type === 'get_profile') {
        const u = DB.getUserById(player.userId);
        if (u) send(ws, 'profile', {
          name: u.name, avatar: u.avatar, level: u.level, balance: u.balance,
          gamesPlayed: u.games_played, wins: u.wins,
          winRate: u.games_played ? Math.round((u.wins / u.games_played) * 100) : 0,
          seat: player.seat
        });
      } else if (type === 'get_history') {
        send(ws, 'history', { items: DB.recentHistory(20) });
      } else if (type === 'get_ranking') {
        send(ws, 'ranking', { items: DB.topPlayers(10) });
      }
    } catch (err) {
      console.error('msg handler error', err);
      send(ws, 'error', { code: 'server_error' });
    }
  });

  ws.on('close', () => {
    if (!player) return;
    if (player.ws !== ws) return;
    player.connected = false;
    player.ws = null;
    broadcast('player_disconnected', { seat: player.seat, name: player.name });
    broadcast('sfx', { sound: 'leave' });
    pushLog({ kind: 'leave', text: player.name + ' disconnected' });
    sendStateToAll();
    if (table.phase === 'playing' && table.turnSeat === player.seat) {
      setTimeout(() => {
        if (!player.connected && table.phase === 'playing' && table.turnSeat === player.seat) doPack(player);
      }, 4000);
    }
    if (table.phase === 'waiting' || table.phase === 'finished') {
      setTimeout(() => {
        if (!player.connected) { leaveTable(player); sendStateToAll(); }
      }, 20000);
    }
  });
  ws.on('error', (err) => console.error('ws error', err.message));
});

/* ============ TIMERS ============ */
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (_) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 25000);

setInterval(() => {
  if (table.phase === 'waiting') {
    const c = seatedPlayers().filter(p => p.connected);
    if (c.length >= MIN_PLAYERS) startRoundIfPossible();
  }
}, 3000);

/* ============ SHUTDOWN ============ */
function shutdown(sig) {
  console.log('Shutting down (' + sig + ')...');
  clearTimers();
  wss.clients.forEach(ws => { try { ws.close(); } catch (_) {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

/* ============ START ============ */
server.listen(PORT, HOST, () => {
  console.log('Teen Patti server on http://' + HOST + ':' + PORT);
});
