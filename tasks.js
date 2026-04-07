import { Database } from "bun:sqlite";
import { join, isAbsolute } from "path";

const DB_PATH = process.env.TASKS_DB
  ? (isAbsolute(process.env.TASKS_DB) ? process.env.TASKS_DB : join(import.meta.dir, process.env.TASKS_DB))
  : join(import.meta.dir, "tasks.db");

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    backend TEXT NOT NULL,
    executor TEXT NOT NULL,
    capability TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    approval_state TEXT DEFAULT '',
    approval_tool TEXT DEFAULT '',
    prompt_summary TEXT DEFAULT '',
    result_summary TEXT DEFAULT '',
    error_code TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    started_at INTEGER DEFAULT NULL,
    finished_at INTEGER DEFAULT NULL,
    updated_at INTEGER NOT NULL
  )
`);

const stmtInsert = db.prepare(`
  INSERT INTO tasks (
    task_id, chat_id, backend, executor, capability, action, status,
    approval_state, approval_tool, prompt_summary, result_summary, error_code,
    created_at, started_at, finished_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdateStatus = db.prepare(`
  UPDATE tasks
  SET status = ?,
      result_summary = COALESCE(?, result_summary),
      error_code = COALESCE(?, error_code),
      finished_at = ?,
      updated_at = ?
  WHERE task_id = ?
`);

const stmtMarkStarted = db.prepare(`
  UPDATE tasks
  SET status = 'running',
      started_at = ?,
      updated_at = ?
  WHERE task_id = ?
`);

const stmtSetApproval = db.prepare(`
  UPDATE tasks
  SET status = ?,
      approval_state = ?,
      approval_tool = ?,
      updated_at = ?
  WHERE task_id = ?
`);

const stmtRecentByChat = db.prepare(`
  SELECT
    task_id, chat_id, backend, executor, capability, action, status,
    approval_state, approval_tool, prompt_summary, result_summary,
    error_code, created_at, started_at, finished_at, updated_at
  FROM tasks
  WHERE chat_id = ?
  ORDER BY updated_at DESC
  LIMIT ?
`);

const stmtActiveByChat = db.prepare(`
  SELECT
    task_id, chat_id, backend, executor, capability, action, status,
    approval_state, approval_tool, prompt_summary, result_summary,
    error_code, created_at, started_at, finished_at, updated_at
  FROM tasks
  WHERE chat_id = ?
    AND status IN ('pending', 'running', 'approval_required')
  ORDER BY updated_at DESC
  LIMIT 1
`);

function nowTs() {
  return Date.now();
}

export function createTask({
  chatId,
  backend,
  executor,
  capability,
  action,
  promptSummary = "",
}) {
  const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = nowTs();
  stmtInsert.run(
    taskId,
    chatId,
    backend,
    executor,
    capability,
    action,
    "pending",
    "",
    "",
    promptSummary,
    "",
    "",
    createdAt,
    null,
    null,
    createdAt,
  );
  return taskId;
}

export function markTaskStarted(taskId) {
  const ts = nowTs();
  stmtMarkStarted.run(ts, ts, taskId);
}

export function setTaskApprovalRequired(taskId, toolName = "") {
  stmtSetApproval.run("approval_required", "pending", toolName, nowTs(), taskId);
}

export function markTaskApproved(taskId, toolName = "") {
  stmtSetApproval.run("running", "approved", toolName, nowTs(), taskId);
}

export function markTaskRejected(taskId, toolName = "") {
  stmtSetApproval.run("failed", "rejected", toolName, nowTs(), taskId);
}

export function completeTask(taskId, resultSummary = "") {
  const ts = nowTs();
  stmtUpdateStatus.run("completed", resultSummary, "", ts, ts, taskId);
}

export function failTask(taskId, resultSummary = "", errorCode = "") {
  const ts = nowTs();
  stmtUpdateStatus.run("failed", resultSummary, errorCode, ts, ts, taskId);
}

export function cancelTask(taskId, resultSummary = "") {
  const ts = nowTs();
  stmtUpdateStatus.run("cancelled", resultSummary, "", ts, ts, taskId);
}

export function recentTasks(chatId, limit = 8) {
  return stmtRecentByChat.all(chatId, limit);
}

export function getActiveTask(chatId) {
  return stmtActiveByChat.get(chatId) || null;
}
