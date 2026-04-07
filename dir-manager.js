// 工作目录切换管理器（借鉴 cc-connect /dir 命令）
// 支持切换、回退、历史记录

import { existsSync, statSync } from "fs";
import { resolve } from "path";

const MAX_HISTORY = 10;

export function createDirManager(defaultCwd) {
  // chatId -> { current, previous, history[] }
  const state = new Map();

  function getState(chatId) {
    if (!state.has(chatId)) {
      state.set(chatId, {
        current: defaultCwd,
        previous: null,
        history: [defaultCwd],
      });
    }
    return state.get(chatId);
  }

  function expandHome(dir) {
    if (dir.startsWith("~/") || dir === "~") {
      return dir.replace("~", process.env.HOME || "/tmp");
    }
    return dir;
  }

  function current(chatId) {
    return getState(chatId).current;
  }

  function switchDir(chatId, newDir) {
    const s = getState(chatId);

    // /dir - 回到上一个目录
    if (newDir === "-") {
      if (!s.previous) {
        return { ok: false, error: "没有上一个目录" };
      }
      const target = s.previous;
      s.previous = s.current;
      s.current = target;
      return { ok: true, prev: s.previous, current: s.current };
    }

    const expanded = expandHome(newDir);
    const resolved = resolve(expanded);

    if (!existsSync(resolved)) {
      return { ok: false, error: `目录不存在: ${resolved}` };
    }

    try {
      if (!statSync(resolved).isDirectory()) {
        return { ok: false, error: `不是目录: ${resolved}` };
      }
    } catch {
      return { ok: false, error: `无法访问: ${resolved}` };
    }

    if (resolved === s.current) {
      return { ok: false, error: `已经在该目录: ${resolved}` };
    }

    s.previous = s.current;
    s.current = resolved;

    // 去重后加入历史
    const idx = s.history.indexOf(resolved);
    if (idx !== -1) s.history.splice(idx, 1);
    s.history.push(resolved);
    if (s.history.length > MAX_HISTORY) s.history.shift();

    return { ok: true, prev: s.previous, current: s.current };
  }

  function previous(chatId) {
    return getState(chatId).previous;
  }

  function history(chatId) {
    return [...getState(chatId).history].reverse();
  }

  return { current, switchDir, previous, history };
}
