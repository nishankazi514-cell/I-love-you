'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'teenpatti.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '🙂',
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
    created_at INTEGER NOT NULL,
    FOREIGN KEY (winner_user_id) REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
  CREATE INDEX IF NOT EXISTS idx_history_round ON game_history(round_id);
`);

const stmts = {
  insertUser: db.prepare(`
    INSERT INTO users (token, name, avatar, balance, level, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  selectByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  selectById: db.prepare('SELECT * FROM users WHERE id = ?'),
  updateProfile: db.prepare(`
    UPDATE users SET name = ?, avatar = ?, updated_at = ? WHERE id = ?
  `),
  updateBalance: db.prepare(`
    UPDATE users SET balance = ?, updated_at = ? WHERE id = ?
  `),
  recordResult: db.prepare(`
    UPDATE users SET games_played = games_played + 1,
      wins = wins + ?,
      balance = ?,
      updated_at = ?
    WHERE id = ?
  `),
  insertHistory: db.prepare(`
    INSERT INTO game_history (round_id, winner_user_id, winner_name, winning_hand, pot, players, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  recentHistory: db.prepare('SELECT * FROM game_history ORDER BY created_at DESC LIMIT ?'),
  topPlayers: db.prepare(`
    SELECT name, avatar, level, balance, wins, games_played
    FROM users ORDER BY wins DESC, balance DESC LIMIT ?
  `)
};

function now() { return Date.now(); }

function createOrGetUser(token, name, avatar) {
  const existing = stmts.selectByToken.get(token);
  if (existing) return existing;
  const t = now();
  const info = stmts.insertUser.run(
    token,
    String(name || 'Player').slice(0, 20),
    String(avatar || '🙂').slice(0, 4),
    5000,
    1,
    t,
    t
  );
  return stmts.selectById.get(info.lastInsertRowid);
}

function getUserByToken(token) {
  return stmts.selectByToken.get(token);
}

function getUserById(id) {
  return stmts.selectById.get(id);
}

function updateProfile(userId, name, avatar) {
  stmts.updateProfile.run(
    String(name || 'Player').slice(0, 20),
    String(avatar || '🙂').slice(0, 4),
    now(),
    userId
  );
  return stmts.selectById.get(userId);
}

function setBalance(userId, balance) {
  const safe = Math.max(0, Math.floor(balance));
  stmts.updateBalance.run(safe, now(), userId);
  return safe;
}

function recordGameResult(userId, newBalance, won) {
  stmts.recordResult.run(won ? 1 : 0, Math.max(0, Math.floor(newBalance)), now(), userId);
}

function saveGameHistory(roundId, winnerUserId, winnerName, winningHand, pot, playersArr) {
  stmts.insertHistory.run(
    roundId,
    winnerUserId || null,
    winnerName || 'None',
    winningHand || 'None',
    Math.max(0, Math.floor(pot)),
    JSON.stringify(playersArr || []),
    now()
  );
}

function getRecentHistory(limit = 20) {
  return stmts.recentHistory.all(Math.min(limit, 100));
}

function getTopPlayers(limit = 10) {
  return stmts.topPlayers.all(Math.min(limit, 50));
}

function getStats() {
  const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const games = db.prepare('SELECT COUNT(*) as c FROM game_history').get().c;
  return { users, games };
}

module.exports = {
  db,
  createOrGetUser,
  getUserByToken,
  getUserById,
  updateProfile,
  setBalance,
  recordGameResult,
  saveGameHistory,
  getRecentHistory,
  getTopPlayers,
  getStats
};
