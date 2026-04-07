// SQLite 会话持久化（bun:sqlite，零外部依赖）
// 支持多后端：backend 字段区分 claude / codex
import { Database } from "bun:sqlite";
import { join, isAbsolute } from "path";

const DB_PATH = process.env.SESSIONS_DB
  ? (isAbsolute(process.env.SESSIONS_DB) ? process.env.SESSIONS_DB : join(import.meta.dir, process.env.SESSIONS_DB))
  : join(import.meta.dir, "sessions.db");

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    chat_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL,
    display_name TEXT DEFAULT '',
    backend TEXT DEFAULT 'claude',
    ownership TEXT DEFAULT 'owned'
  )
`);

// 迁移：旧表没有 backend 列时自动加
try {
  db.exec("ALTER TABLE sessions ADD COLUMN backend TEXT DEFAULT 'claude'");
} catch {
  // 列已存在，忽略
}
try {
  db.exec("ALTER TABLE sessions ADD COLUMN ownership TEXT DEFAULT 'owned'");
} catch {
  // 列已存在，忽略
}

// 会话历史表（保留所有历史会话，不被 /new 或 upsert 覆盖）
db.exec(`
  CREATE TABLE IF NOT EXISTS session_history (
    session_id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL,
    display_name TEXT DEFAULT '',
    backend TEXT DEFAULT 'claude',
    ownership TEXT DEFAULT 'owned'
  )
`);
try {
  db.exec("ALTER TABLE session_history ADD COLUMN ownership TEXT DEFAULT 'owned'");
} catch {
  // 列已存在，忽略
}

// 后端偏好表（每个 chat 独立选后端）
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_backend (
    chat_id INTEGER PRIMARY KEY,
    backend TEXT NOT NULL DEFAULT 'claude'
  )
`);

// Prepared statements — sessions
const stmtGet = db.prepare("SELECT session_id, last_active, backend, ownership FROM sessions WHERE chat_id = ?");
const stmtUpsert = db.prepare(`
  INSERT INTO sessions (chat_id, session_id, created_at, last_active, display_name, backend, ownership)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    session_id = excluded.session_id,
    last_active = excluded.last_active,
    display_name = excluded.display_name,
    backend = excluded.backend,
    ownership = excluded.ownership
`);
const stmtDelete = db.prepare("DELETE FROM sessions WHERE chat_id = ?");
const stmtRecentAll = db.prepare(`
  SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM (
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM sessions
    UNION ALL
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM session_history
  ) ORDER BY last_active DESC LIMIT ?
`);
const stmtRecentByChat = db.prepare(`
  SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM (
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM sessions
    UNION ALL
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM session_history
  ) WHERE chat_id = ?
  ORDER BY last_active DESC LIMIT ?
`);
const stmtRecentByChatAndBackend = db.prepare(`
  SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM (
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM sessions
    UNION ALL
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM session_history
  ) WHERE chat_id = ? AND backend = ?
  ORDER BY last_active DESC LIMIT ?
`);
const stmtRecentByChatBackendAndOwnership = db.prepare(`
  SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM (
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM sessions
    UNION ALL
    SELECT chat_id, session_id, created_at, last_active, display_name, backend, ownership FROM session_history
  ) WHERE chat_id = ? AND backend = ? AND ownership = ?
  ORDER BY last_active DESC LIMIT ?
`);
const stmtCleanup = db.prepare("DELETE FROM sessions WHERE last_active < ?");
const stmtCleanupHistory = db.prepare("DELETE FROM session_history WHERE last_active < ?");
const stmtTouch = db.prepare("UPDATE sessions SET last_active = ? WHERE chat_id = ?");

// History statements
const stmtArchive = db.prepare(`
  INSERT OR REPLACE INTO session_history (session_id, chat_id, created_at, last_active, display_name, backend, ownership)
  SELECT session_id, chat_id, created_at, last_active, display_name, backend, ownership FROM sessions WHERE chat_id = ?
`);
const stmtGetHistory = db.prepare(
  "SELECT session_id, chat_id, created_at, last_active, display_name, backend, ownership FROM session_history WHERE session_id = ?"
);
const stmtDeleteFromHistory = db.prepare("DELETE FROM session_history WHERE session_id = ?");
const stmtHasSessionForChat = db.prepare(`
  SELECT 1 AS ok FROM (
    SELECT chat_id, session_id, backend, ownership FROM sessions
    UNION ALL
    SELECT chat_id, session_id, backend, ownership FROM session_history
  )
  WHERE chat_id = ?
    AND session_id = ?
    AND (? IS NULL OR backend = ?)
    AND (? IS NULL OR ownership = ?)
  LIMIT 1
`);

// Prepared statements — chat_backend
const stmtGetBackendPref = db.prepare("SELECT backend FROM chat_backend WHERE chat_id = ?");
const stmtSetBackendPref = db.prepare(`
  INSERT INTO chat_backend (chat_id, backend) VALUES (?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET backend = excluded.backend
`);

// 模型偏好表（每个 chat 独立选模型，跨重启持久化）
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_model (
    chat_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL
  )
`);
const stmtGetModelPref = db.prepare("SELECT model FROM chat_model WHERE chat_id = ?");
const stmtSetModelPref = db.prepare(`
  INSERT INTO chat_model (chat_id, model) VALUES (?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET model = excluded.model
`);
const stmtDeleteModelPref = db.prepare("DELETE FROM chat_model WHERE chat_id = ?");

// Effort 偏好表（每个 chat 独立选 effort，跨重启持久化）
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_effort (
    chat_id INTEGER PRIMARY KEY,
    effort TEXT NOT NULL
  )
`);
const stmtGetEffortPref = db.prepare("SELECT effort FROM chat_effort WHERE chat_id = ?");
const stmtSetEffortPref = db.prepare(`
  INSERT INTO chat_effort (chat_id, effort) VALUES (?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET effort = excluded.effort
`);
const stmtDeleteEffortPref = db.prepare("DELETE FROM chat_effort WHERE chat_id = ?");

export function getSession(chatId) {
  const row = stmtGet.get(chatId);
  if (!row) return null;
  // Touch last_active
  stmtTouch.run(Date.now(), chatId);
  return {
    session_id: row.session_id,
    backend: row.backend || "claude",
    ownership: row.ownership || "owned",
  };
}

export function setSession(
  chatId,
  sessionId,
  displayName = "",
  backend = "claude",
  ownership = "owned",
) {
  // 归档旧会话（如果有）
  stmtArchive.run(chatId);
  // 从历史中移除（避免恢复后重复出现）
  stmtDeleteFromHistory.run(sessionId);
  const now = Date.now();
  stmtUpsert.run(chatId, sessionId, now, now, displayName, backend, ownership);
}

export function deleteSession(chatId) {
  // 归档到历史再删除
  stmtArchive.run(chatId);
  stmtDelete.run(chatId);
}

export function getHistorySession(sessionId) {
  return stmtGetHistory.get(sessionId) || null;
}

export function recentSessions(limit = 8, options = {}) {
  const { chatId = null, backend = null, ownership = null } = options;
  if (chatId != null && backend && ownership) {
    return stmtRecentByChatBackendAndOwnership.all(chatId, backend, ownership, limit);
  }
  if (chatId != null && backend) {
    return stmtRecentByChatAndBackend.all(chatId, backend, limit);
  }
  if (chatId != null) {
    return stmtRecentByChat.all(chatId, limit);
  }
  return stmtRecentAll.all(limit);
}

export function cleanupExpired() {
  // 当前会话默认长期保留，直到用户显式 /new 或 /resume 切换。
  // 历史表仍然定期清理，避免只读预览列表无限增长。
  const historyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const result = stmtCleanupHistory.run(historyCutoff);
  return result.changes;
}

export function sessionBelongsToChat(chatId, sessionId, backend = null, ownership = null) {
  return Boolean(
    stmtHasSessionForChat.get(
      chatId,
      sessionId,
      backend,
      backend,
      ownership,
      ownership,
    ),
  );
}

export function getChatBackend(chatId) {
  const row = stmtGetBackendPref.get(chatId);
  return row?.backend || null;
}

export function setChatBackend(chatId, backend) {
  stmtSetBackendPref.run(chatId, backend);
}

export function getChatModel(chatId) {
  const row = stmtGetModelPref.get(chatId);
  return row?.model || null;
}

export function setChatModel(chatId, model) {
  stmtSetModelPref.run(chatId, model);
}

export function deleteChatModel(chatId) {
  stmtDeleteModelPref.run(chatId);
}

export function getChatEffort(chatId) {
  const row = stmtGetEffortPref.get(chatId);
  return row?.effort || null;
}

export function setChatEffort(chatId, effort) {
  stmtSetEffortPref.run(chatId, effort);
}

export function deleteChatEffort(chatId) {
  stmtDeleteEffortPref.run(chatId);
}

// 每 30 分钟自动清理过期会话
setInterval(cleanupExpired, 30 * 60 * 1000);
