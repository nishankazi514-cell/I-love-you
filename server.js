'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const db = require('./database');
const {
  createDeck,
  shuffleDeck,
  evaluateHand,
  compareHands,
  rankValue,
  HAND_NAMES
} = require('./game-logic');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    players: getConnectedCount(),
    phase: table.phase,
    time: Date.now()
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- Game state ----------------
const TURN_TIMEOUT_MS = 20000;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const BASE_BET = 100;
const SEATS = [0, 1, 2, 3];

const table = {
  phase: 'waiting', // waiting | starting | dealing | playing | showdown | finished
  players: [], // { userId, token, name, avatar, level, seat, balance, cards, packed, seenCards, connected, ws, lastActionAt }
  deck: [],
  pot: 0,
  currentStake: BASE_BET,
  turnSeat: -1,
  turnDeadline: 0,
  roundId: null,
  roundStartAt: 0,
  sideShowRequest: null, // { fromSeat, toSeat, expires }
  handResults: [],
  winnerInfo: null,
  botTimer: null,
  turnTimer: null,
  dealTimer: null,
  lastRaiserSeat: -1,
  chaalCount: 0,
  log: [] // recent events for replay on join
};

function pushLog(event) {
  table.log.push({ ...event, ts: Date.now() });
  if (table.log.length > 60) table.log.shift();
}

function getConnectedCount() {
  return table.players.filter(p => p.connected).length;
}

function getSeatedPlayers() {
  return table.players.filter(p => p.seat >= 0);
}

function getActivePlayers() {
  return getSeatedPlayers().filter(p => !p.packed);
}

function seatAvailable() {
  const used = new Set(getSeatedPlayers().map(p => p.seat));
  for (const s of SEATS) if (!used.has(s)) return s;
  return -1;
}

function findPlayerById(id) {
  return table.players.find(p => p.userId === id);
}

function findPlayerByToken(token) {
  return table.players.find(p => p.token === token);
}

function findPlayerBySeat(seat) {
  return table.players.find(p => p.seat === seat);
}

function seatPublic(p) {
  return {
    userId: p.userId,
    name: p.name,
    avatar: p.avatar,
    level: p.level,
    seat: p.seat,
    balance: p.balance,
    packed: !!p.packed,
    connected: !!p.connected,
    seenCards: !!p.seenCards,
    cardsCount: p.cards.length,
    isTurn: table.turnSeat === p.seat && table.phase === 'playing',
    cards: null // filled per-client if authorized
  };
}

function buildPublicState() {
  return {
    phase: table.phase,
    pot: table.pot,
    currentStake: table.currentStake,
    turnSeat: table.turnSeat,
    turnDeadline: table.turnDeadline,
    serverNow: Date.now(),
    deckCount: table.deck.length,
    players: getSeatedPlayers().map(seatPublic),
    sideShowRequest: table.sideShowRequest,
    winner: table.winnerInfo,
    handResults: table.handResults,
    roundId: table.roundId,
    log: table.log.slice(-25)
  };
}

// ---------------- WebSocket helpers ----------------
function send(ws, type, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify({ type, payload }));
  } catch (e) {
    console.error('send error', e.message);
  }
}

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  for (const p of table.players) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) {
      try { p.ws.send(msg); } catch (e) { /* ignore */ }
    }
  }
}

function sendStateToAll() {
  const base = buildPublicState();
  for (const p of table.players) {
    if (!p.ws || p.ws.readyState !== p.ws.OPEN) continue;
    const state = { ...base };
    // Fill per-player private card visibility
    state.players = base.players.map(sp => {
      const self = p.seat === sp.seat;
      const other = findPlayerBySeat(sp.seat);
      if (!other) return sp;
      let cards = null;
      if (self && other.cards.length) {
        // Own cards: visible once "seen". Before seeing, show backs (null values)
        cards = other.seenCards || table.phase === 'showdown' || table.phase === 'finished'
          ? other.cards
          : other.cards.map(() => ({ hidden: true }));
      } else if (table.phase === 'showdown' || table.phase === 'finished') {
        // Everyone sees revealed hands during showdown
        if (other.revealed || table.phase === 'finished') {
          cards = other.cards;
        } else {
          cards = other.cards.map(() => ({ hidden: true }));
        }
      } else {
        // Hide other players' cards
        cards = other.cards.length ? other.cards.map(() => ({ hidden: true })) : null;
      }
      return { ...sp, cards };
    });
    state.you = {
      userId: p.userId,
      seat: p.seat,
      balance: p.balance,
      cards: p.cards,
      seenCards: p.seenCards,
      packed: p.packed,
      canAct: table.phase === 'playing' && table.turnSeat === p.seat && !p.packed
    };
    send(p.ws, 'state', state);
  }
}

// ---------------- Round lifecycle ----------------
function newRoundId() {
  return crypto.randomBytes(8).toString('hex');
}

function startRoundIfPossible() {
  const seated = getSeatedPlayers().filter(p => p.connected);
  if (seated.length < MIN_PLAYERS) {
    table.phase = 'waiting';
    pushLog({ kind: 'info', text: 'Waiting for players' });
    sendStateToAll();
    return;
  }
  startRound();
}

function startRound() {
  clearTimers();
  table.roundId = newRoundId();
  table.roundStartAt = Date.now();
  table.phase = 'starting';
  table.pot = 0;
  table.currentStake = BASE_BET;
  table.chaalCount = 0;
  table.winnerInfo = null;
  table.handResults = [];
  table.sideShowRequest = null;
  table.lastRaiserSeat = -1;

  for (const p of getSeatedPlayers()) {
    p.packed = false;
    p.seenCards = false;
    p.cards = [];
    p.revealed = false;
    p.lastAction = null;
  }

  // Reset any negative-guards
  for (const p of getSeatedPlayers()) {
    if (p.balance < BASE_BET) {
      // top up to avoid stuck state; keep them eligible
      p.balance = Math.max(p.balance, BASE_BET * 5);
      db.setBalance(p.userId, p.balance);
    }
  }

  table.deck = shuffleDeck(createDeck());

  broadcast('round_starting', { roundId: table.roundId });
  pushLog({ kind: 'round', text: 'Round starting' });
  sendStateToAll();

  // Deal sequence
  const dealSeq = [];
  const seatedSorted = getSeatedPlayers().sort((a, b) => a.seat - b.seat);
  for (let cardIdx = 0; cardIdx < 3; cardIdx++) {
    for (const p of seatedSorted) {
      dealSeq.push({ seat: p.seat, cardIdx });
    }
  }

  table.phase = 'dealing';
  let i = 0;
  const DEAL_INTERVAL = 220;

  const dealNext = () => {
    if (i >= dealSeq.length) {
      // Betting starts
      table.phase = 'playing';
      table.currentStake = BASE_BET;
      table.turnSeat = nextSeatAfter(getSeatedPlayers()[0].seat);
      // Determine first turn: player after dealer (we use lowest seat as reference)
      const firstSeat = getSeatedPlayers().slice().sort((a, b) => a.seat - b.seat)[0].seat;
      // In Teen Patti, first turn is usually determined by dealer; we rotate. For simplicity: player to the left of previous starter
      table.turnSeat = firstSeat;
      resetTurnTimer();
      broadcast('phase', { phase: 'playing' });
      sendStateToAll();
      return;
    }

    const step = dealSeq[i++];
    const player = findPlayerBySeat(step.seat);
    if (!player) { dealNext(); return; }

    const card = table.deck.pop();
    if (!card) { dealNext(); return; }
    player.cards.push(card);

    // Broadcast a public deal event (card identity hidden from other players)
    broadcast('deal', {
      seat: step.seat,
      cardIdx: step.cardIdx,
      cardPublic: { hidden: true },
      deckCount: table.deck.length
    });

    // Send private card to the owner
    if (player.ws && player.ws.readyState === player.ws.OPEN) {
      send(player.ws, 'private_card', { card, cardIdx: step.cardIdx });
    }

    sendStateToAll();
    table.dealTimer = setTimeout(dealNext, DEAL_INTERVAL);
  };

  setTimeout(() => {
    broadcast('shuffle', { deckCount: table.deck.length });
    table.dealTimer = setTimeout(dealNext, 500);
  }, 200);
}

function nextSeatAfter(seat) {
  const order = getSeatedPlayers().map(p => p.seat).sort((a, b) => a - b);
  if (!order.length) return -1;
  const idx = order.indexOf(seat);
  const nextIdx = (idx + 1) % order.length;
  return order[nextIdx];
}

function nextActiveSeatAfter(seat) {
  const activeSeats = getActivePlayers().map(p => p.seat).sort((a, b) => a - b);
  if (!activeSeats.length) return -1;
  // find first active seat > seat, else wrap to lowest
  for (const s of activeSeats) if (s > seat) return s;
  return activeSeats[0];
}

function clearTimers() {
  if (table.turnTimer) { clearTimeout(table.turnTimer); table.turnTimer = null; }
  if (table.dealTimer) { clearTimeout(table.dealTimer); table.dealTimer = null; }
  if (table.botTimer) { clearTimeout(table.botTimer); table.botTimer = null; }
}

function resetTurnTimer() {
  if (table.turnTimer) clearTimeout(table.turnTimer);
  table.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  table.turnTimer = setTimeout(() => {
    handleTurnTimeout();
  }, TURN_TIMEOUT_MS + 50);
  broadcast('turn', {
    turnSeat: table.turnSeat,
    turnDeadline: table.turnDeadline,
    serverNow: Date.now()
  });
}

function handleTurnTimeout() {
  if (table.phase !== 'playing') return;
  const p = findPlayerBySeat(table.turnSeat);
  if (!p) { advanceTurn(); return; }
  pushLog({ kind: 'action', text: `${p.name} auto-packed (timeout)` });
  doPack(p, true);
}

function doPack(p, isAuto = false) {
  if (p.packed) return;
  p.packed = true;
  p.lastAction = 'pack';
  broadcast('sfx', { sound: 'pack', seat: p.seat });
  pushLog({ kind: 'action', text: `${p.name} packed` });
  advanceTurn();
}

function advanceTurn() {
  const active = getActivePlayers();
  if (active.length <= 1) {
    // Round ends early
    if (active.length === 1) {
      endRound(active[0], null, 'Others packed');
    } else {
      endRound(null, null, 'All packed');
    }
    return;
  }

  // Optional: max chaal limit — cap to prevent infinite
  if (table.chaalCount > 40) {
    // Force showdown by comparing hands
    resolveShowdown();
    return;
  }

  const next = nextActiveSeatAfter(table.turnSeat);
  table.turnSeat = next;
  resetTurnTimer();
  sendStateToAll();
}

// ---------------- Actions ----------------
function handleAction(ws, player, action, payload) {
  if (!player) return;
  const now = Date.now();

  if (action === 'ping') { send(ws, 'pong', { t: now }); return; }

  if (action === 'sit') {
    handleSit(ws, player, payload);
    return;
  }

  if (action === 'set_profile') {
    const name = String(payload?.name || '').slice(0, 20);
    const avatar = String(payload?.avatar || '🙂').slice(0, 4);
    if (name) {
      const updated = db.updateProfile(player.userId, name, avatar);
      player.name = updated.name;
      player.avatar = updated.avatar;
      broadcast('profile_updated', { userId: player.userId, name: player.name, avatar: player.avatar });
      sendStateToAll();
    }
    return;
  }

  if (action === 'chat') {
    const text = String(payload?.text || '').slice(0, 200).trim();
    if (!text) return;
    const now2 = Date.now();
    if (player._lastChatAt && now2 - player._lastChatAt < 800) return;
    player._lastChatAt = now2;
    broadcast('chat', {
      userId: player.userId,
      name: player.name,
      avatar: player.avatar,
      text: sanitize(text),
      ts: now2
    });
    return;
  }

  if (action === 'emoji') {
    const emoji = String(payload?.emoji || '').slice(0, 8);
    if (!emoji) return;
    broadcast('emoji', { seat: player.seat, emoji, name: player.name, ts: now });
    return;
  }

  // In-game actions require turn
  if (table.phase !== 'playing') return;
  if (table.turnSeat !== player.seat) {
    send(ws, 'error', { code: 'not_your_turn' });
    return;
  }
  if (player.packed) {
    send(ws, 'error', { code: 'packed' });
    return;
  }

  if (action === 'see_cards') {
    player.seenCards = true;
    send(ws, 'see_cards', { cards: player.cards });
    sendStateToAll();
    return;
  }

  if (action === 'pack') {
    doPack(player);
    return;
  }

  if (action === 'chaal' || action === 'chaal_2x') {
    const isSeen = player.seenCards;
    let amount = table.currentStake;
    if (isSeen) amount = amount * 2;
    if (action === 'chaal_2x') amount = amount * 2;

    // Cap by balance: if not enough, pack
    if (player.balance < amount) {
      send(ws, 'error', { code: 'insufficient' });
      doPack(player);
      return;
    }

    player.balance -= amount;
    table.pot += amount;
    db.setBalance(player.userId, player.balance);

    // Update stake for next players (only chaal_2x raises the stake)
    if (action === 'chaal_2x') {
      table.currentStake = amount / (isSeen ? 2 : 1);
      table.lastRaiserSeat = player.seat;
    }
    table.chaalCount++;

    broadcast('chips', { seat: player.seat, amount, toPot: true });
    broadcast('sfx', { sound: action === 'chaal_2x' ? 'chaal2x' : 'chaal', seat: player.seat });
    pushLog({ kind: 'action', text: `${player.name} ${action === 'chaal_2x' ? '2x Chaal' : 'Chaal'} ${amount}` });

    sendStateToAll();
    advanceTurn();
    return;
  }

  if (action === 'side_show') {
    // Side Show: only if > 2 active players and current player seen their cards is optional
    const active = getActivePlayers();
    if (active.length < 3) {
      send(ws, 'error', { code: 'sideshow_unavailable' });
      return;
    }
    const targetSeat = nextActiveSeatAfter(player.seat);
    if (targetSeat < 0 || targetSeat === player.seat) {
      send(ws, 'error', { code: 'sideshow_unavailable' });
      return;
    }
    table.sideShowRequest = {
      fromSeat: player.seat,
      fromName: player.name,
      toSeat: targetSeat,
      toName: (findPlayerBySeat(targetSeat) || {}).name,
      expires: Date.now() + 10000
    };
    broadcast('side_show_request', table.sideShowRequest);
    broadcast('sfx', { sound: 'sideshow' });
    pushLog({ kind: 'action', text: `${player.name} requests Side Show with ${table.sideShowRequest.toName}` });
    sendStateToAll();

    // Auto-reject after expiry
    setTimeout(() => {
      if (table.sideShowRequest && table.sideShowRequest.fromSeat === player.seat) {
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
    const accepted = !!payload?.accept;
    table.sideShowRequest = null;

    if (!accepted) {
      broadcast('side_show_resolved', { accepted: false });
      sendStateToAll();
      return;
    }

    const from = findPlayerBySeat(req.fromSeat);
    if (!from || from.packed || player.packed) {
      broadcast('side_show_resolved', { accepted: false, reason: 'invalid' });
      sendStateToAll();
      return;
    }

    // Compare hands
    const cmp = compareHands(from.cards, player.cards);
    // Side Show rule: whoever loses packs
    let loser;
    if (cmp > 0) loser = player; else if (cmp < 0) loser = from; else loser = player; // tie -> target loses (documented rule)
    loser.packed = true;
    loser.lastAction = 'pack';

    broadcast('side_show_resolved', {
      accepted: true,
      winnerSeat: loser.seat === from.seat ? player.seat : from.seat,
      loserSeat: loser.seat
    });
    broadcast('sfx', { sound: 'show' });
    pushLog({ kind: 'action', text: `Side Show: ${loser.name} packed` });
    sendStateToAll();

    // If it was target's turn next, skip them; our turn was current player who requested, so advance
    advanceTurn();
    return;
  }

  if (action === 'show') {
    // Show: allowed when 2+ active players and either it's a showdown or player initiates
    const active = getActivePlayers();
    if (active.length < 2) {
      send(ws, 'error', { code: 'show_unavailable' });
      return;
    }
    // Mark player revealed and end round via showdown
    player.revealed = true;
    resolveShowdown(player.seat);
    return;
  }
}

function sanitize(s) {
  return String(s).replace(/[<>&"']/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function resolveShowdown(initiatorSeat = null) {
  table.phase = 'showdown';
  clearTimers();
  const active = getActivePlayers();
  // Reveal all active players' cards
  for (const p of active) p.revealed = true;

  const results = active.map(p => {
    const evalRes = evaluateHand(p.cards);
    return { seat: p.seat, userId: p.userId, name: p.name, cards: p.cards, ...evalRes };
  });

  // Find best
  results.sort((a, b) => b.score - a.score);

  const best = results[0];
  // Handle tie: split pot equally among tied best
  const tied = results.filter(r => r.score === best.score);
  const potShare = Math.floor(table.pot / tied.length);

  table.handResults = results;

  for (const t of tied) {
    const p = findPlayerBySeat(t.seat);
    if (!p) continue;
    p.balance += potShare;
    db.setBalance(p.userId, p.balance);
    db.recordGameResult(p.userId, p.balance, true);
  }
  // Record losses for others
  for (const r of results) {
    if (tied.find(t => t.seat === r.seat)) continue;
    const p = findPlayerBySeat(r.seat);
    if (!p) continue;
    db.recordGameResult(p.userId, p.balance, false);
  }
  // Also record packed players
  for (const p of getSeatedPlayers()) {
    if (!results.find(r => r.seat === p.seat)) {
      db.recordGameResult(p.userId, p.balance, false);
    }
  }

  const winnerNames = tied.map(t => t.name).join(', ');
  table.winnerInfo = {
    seats: tied.map(t => t.seat),
    names: winnerNames,
    handName: best.categoryName,
    pot: table.pot,
    potShare
  };

  db.saveGameHistory(
    table.roundId,
    tied.length === 1 ? tied[0].userId : null,
    winnerNames,
    best.categoryName,
    table.pot,
    getSeatedPlayers().map(p => ({ name: p.name, seat: p.seat }))
  );

  broadcast('sfx', { sound: 'winner' });
  broadcast('showdown', {
    results: results.map(r => ({
      seat: r.seat, name: r.name, cards: r.cards,
      category: r.categoryName, score: r.score
    })),
    winner: table.winnerInfo
  });
  pushLog({ kind: 'result', text: `${winnerNames} won ${table.pot} (${best.categoryName})` });

  table.phase = 'finished';
  sendStateToAll();

  // Auto start next round after delay
  table.botTimer = setTimeout(() => {
    if (table.phase === 'finished') startRoundIfPossible();
  }, 6000);
}

function endRound(winner, winningHand, reason) {
  if (winner) {
    winner.balance += table.pot;
    db.setBalance(winner.userId, winner.balance);
    db.recordGameResult(winner.userId, winner.balance, true);
    const others = getSeatedPlayers().filter(p => p.seat !== winner.seat);
    for (const o of others) db.recordGameResult(o.userId, o.balance, false);

    table.winnerInfo = {
      seats: [winner.seat],
      names: winner.name,
      handName: winningHand || reason || 'Win',
      pot: table.pot,
      potShare: table.pot
    };
    broadcast('sfx', { sound: 'winner' });
    pushLog({ kind: 'result', text: `${winner.name} won ${table.pot} (${reason})` });
    db.saveGameHistory(table.roundId, winner.userId, winner.name, reason || 'Win', table.pot,
      getSeatedPlayers().map(p => ({ name: p.name, seat: p.seat })));
  } else {
    table.winnerInfo = { seats: [], names: '', handName: '', pot: table.pot, potShare: 0 };
  }
  table.phase = 'finished';
  sendStateToAll();
  table.botTimer = setTimeout(() => {
    if (table.phase === 'finished') startRoundIfPossible();
  }, 5000);
}

function handleSit(ws, player, payload) {
  if (player.seat >= 0) return; // already seated
  const seat = seatAvailable();
  if (seat < 0) {
    send(ws, 'error', { code: 'table_full' });
    return;
  }
  player.seat = seat;
  player.packed = false;
  player.cards = [];
  player.seenCards = false;
  pushLog({ kind: 'join', text: `${player.name} joined the table` });
  broadcast('sfx', { sound: 'join' });
  broadcast('player_joined', { seat, name: player.name });
  sendStateToAll();

  if (table.phase === 'waiting') {
    startRoundIfPossible();
  }
}

// ---------------- WebSocket connection ----------------
function getConnectedCount2() { return getConnectedCount(); }

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (e) { send(ws, 'error', { code: 'bad_json' }); return; }

    const { type, payload } = msg || {};
    try {
      if (type === 'hello') {
        const token = String(payload?.token || '').slice(0, 64);
        const name = String(payload?.name || 'Player').slice(0, 20);
        const avatar = String(payload?.avatar || '🙂').slice(0, 4);
        if (!token) { send(ws, 'error', { code: 'no_token' }); return; }

        const user = db.createOrGetUser(token, name, avatar);

        // Existing live player with same token: replace ws
        let existing = findPlayerByToken(token);
        if (existing && existing.ws && existing.ws !== ws) {
          try { existing.ws.close(); } catch (e) {}
        }

        if (existing) {
          existing.ws = ws;
          existing.connected = true;
          existing.name = user.name;
          existing.avatar = user.avatar;
          existing.balance = user.balance;
          existing.level = user.level;
          player = existing;
        } else {
          player = {
            userId: user.id,
            token: user.token,
            name: user.name,
            avatar: user.avatar,
            level: user.level,
            seat: -1,
            balance: user.balance,
            cards: [],
            packed: false,
            seenCards: false,
            connected: true,
            ws,
            lastActionAt: Date.now()
          };
          table.players.push(player);
        }

        send(ws, 'hello_ok', {
          userId: user.id,
          name: user.name,
          avatar: user.avatar,
          balance: user.balance,
          level: user.level,
          gamesPlayed: user.games_played,
          wins: user.wins,
          seat: player.seat
        });

        // Send recent log
        send(ws, 'log_history', { log: table.log.slice(-25) });
        sendStateToAll();
        return;
      }

      if (!player) {
        send(ws, 'error', { code: 'not_authenticated' });
        return;
      }

      if (type === 'action') {
        handleAction(ws, player, payload?.action, payload);
      } else if (type === 'get_profile') {
        const u = db.getUserById(player.userId);
        if (u) send(ws, 'profile', {
          name: u.name, avatar: u.avatar, level: u.level, balance: u.balance,
          gamesPlayed: u.games_played, wins: u.wins,
          winRate: u.games_played ? Math.round((u.wins / u.games_played) * 100) : 0,
          seat: player.seat
        });
      } else if (type === 'get_history') {
        send(ws, 'history', { items: db.getRecentHistory(20) });
      } else if (type === 'get_ranking') {
        send(ws, 'ranking', { items: db.getTopPlayers(10) });
      } else if (type === 'leave_table') {
        leaveTable(player);
        sendStateToAll();
      }
    } catch (err) {
      console.error('message handler error', err);
      send(ws, 'error', { code: 'server_error' });
    }
  });

  ws.on('close', () => {
    if (!player) return;
    if (player.ws === ws) {
      player.connected = false;
      player.ws = null;
      broadcast('player_disconnected', { seat: player.seat, name: player.name });
      broadcast('sfx', { sound: 'leave' });
      pushLog({ kind: 'leave', text: `${player.name} disconnected` });
      sendStateToAll();

      // If round is in progress and it's their turn -> auto pack after a grace
      if (table.phase === 'playing' && table.turnSeat === player.seat) {
        setTimeout(() => {
          if (!player.connected && table.phase === 'playing' && table.turnSeat === player.seat) {
            doPack(player, true);
          }
        }, 4000);
      }

      // Remove them fully if waiting
      if (table.phase === 'waiting' || table.phase === 'finished') {
        setTimeout(() => {
          if (!player.connected) leaveTable(player);
          sendStateToAll();
          // Start next round if possible
          if (table.phase !== 'playing' && table.phase !== 'dealing') {
            if (getActivePlayers().length >= MIN_PLAYERS) startRoundIfPossible();
          }
        }, 20000);
      }
    }
  });

  ws.on('error', (err) => console.error('ws error', err.message));
});

function leaveTable(player) {
  if (!player) return;
  if (player.ws && player.ws.readyState === player.ws.OPEN) {
    try { send(player.ws, 'left_table', {}); } catch (e) {}
  }
  const idx = table.players.indexOf(player);
  if (idx >= 0) table.players.splice(idx, 1);
  pushLog({ kind: 'leave', text: `${player.name} left the table` });
  broadcast('sfx', { sound: 'leave' });
  broadcast('player_left', { seat: player.seat, name: player.name });

  // If it was their turn, advance
  if (table.phase === 'playing' && table.turnSeat === player.seat) {
    advanceTurn();
  }
  if (table.phase === 'playing' && getActivePlayers().length <= 1) {
    const a = getActivePlayers();
    if (a.length === 1) endRound(a[0], null, 'Others left');
    else { table.phase = 'waiting'; startRoundIfPossible(); }
  }
}

// Heartbeat
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);

// Start a server-side "waiting" heartbeat to attempt auto start
setInterval(() => {
  if (table.phase === 'waiting' || table.phase === 'finished') {
    const connected = getSeatedPlayers().filter(p => p.connected);
    if (connected.length >= MIN_PLAYERS && table.phase === 'waiting') {
      startRoundIfPossible();
    }
  }
}, 3000);

// graceful shutdown
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
function shutdown(sig) {
  console.log(`Shutting down (${sig})...`);
  clearTimers();
  wss.clients.forEach(ws => { try { ws.close(); } catch (e) {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}

process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));

server.listen(PORT, HOST, () => {
  console.log(`Teen Patti server running on http://${HOST}:${PORT}`);
});
