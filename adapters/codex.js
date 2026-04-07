// Codex SDK 适配器
// @openai/codex-sdk — CLI wrapper，sessions 存 ~/.codex/sessions/
// codex resume <threadId> 终端可直接接续

import { readdirSync, statSync, createReadStream } from "fs";
import { basename, join } from "path";
import { createInterface } from "readline";

let Codex;
try {
  ({ Codex } = await import("@openai/codex-sdk"));
} catch {
  // SDK 未安装时给出友好提示，不阻塞 Claude 后端
  Codex = null;
}

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CODEX_MODEL || "";
  const cwd = config.cwd || process.env.CC_CWD || process.env.HOME;

  // 按模型缓存 SDK 实例
  const sdkCache = new Map();

  function ensureSDK(modelOverride) {
    if (!Codex) {
      throw new Error("@openai/codex-sdk not installed. Run: bun add @openai/codex-sdk");
    }
    const m = modelOverride || defaultModel;
    const key = m || "__default__";
    if (!sdkCache.has(key)) {
      const opts = {};
      if (m) opts.config = { model: m };
      sdkCache.set(key, new Codex(opts));
    }
    return sdkCache.get(key);
  }

  function listRecentSessionFiles(limit = 10) {
    const sessionsDir = join(process.env.HOME, ".codex", "sessions");
    const allFiles = [];

    try {
      const now = new Date();
      for (let d = 0; d < 7; d++) {
        const date = new Date(now - d * 86400000);
        const yyyy = String(date.getFullYear());
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const dayDir = join(sessionsDir, yyyy, mm, dd);

        try {
          const files = readdirSync(dayDir)
            .filter(f => f.endsWith(".jsonl"))
            .map(f => {
              const fp = join(dayDir, f);
              const stat = statSync(fp);
              const uuidMatch = f.match(/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jsonl$/i);
              const sessionId = uuidMatch ? uuidMatch[1] : f.replace(".jsonl", "");
              return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, sessionId };
            });
          allFiles.push(...files);
        } catch { /* day dir not found */ }
      }
    } catch {
      return [];
    }

    allFiles.sort((a, b) => b.mtime - a.mtime);
    return allFiles.slice(0, limit);
  }

  function findSessionFile(sessionId) {
    const sessionsDir = join(process.env.HOME, ".codex", "sessions");
    try {
      for (const yyyy of readdirSync(sessionsDir)) {
        const yearDir = join(sessionsDir, yyyy);
        try {
          if (!statSync(yearDir).isDirectory()) continue;
        } catch {
          continue;
        }
        for (const mm of readdirSync(yearDir)) {
          const monthDir = join(yearDir, mm);
          try {
            if (!statSync(monthDir).isDirectory()) continue;
          } catch {
            continue;
          }
          for (const dd of readdirSync(monthDir)) {
            const dayDir = join(monthDir, dd);
            try {
              if (!statSync(dayDir).isDirectory()) continue;
            } catch {
              continue;
            }
            const match = readdirSync(dayDir).find(f => f.endsWith(`${sessionId}.jsonl`));
            if (match) {
              const path = join(dayDir, match);
              const stat = statSync(path);
              return { file: match, path, mtime: stat.mtimeMs, size: stat.size, sessionId };
            }
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  function detectSessionSource(meta) {
    const originator = String(meta.originator || "");
    const source = String(meta.source || "");
    if (source === "cli" || originator.includes("cli")) return "CLI";
    if (originator.includes("sdk")) return "SDK";
    if (source === "exec") return "Exec";
    return source || originator || "";
  }

  async function parseSessionFile(fileInfo) {
    let topic = "";
    let sessionMeta = null;

    try {
      const stream = createReadStream(fileInfo.path, { encoding: "utf8" });
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);
          if (!sessionMeta && d.type === "session_meta" && d.payload) {
            sessionMeta = d.payload;
          }
          if (!topic && d.type === "event_msg" && d.payload?.type === "user_message") {
            const msg = String(d.payload.message || "").trim();
            if (msg && !/^\/[a-z]/i.test(msg)) {
              topic = msg.slice(0, 80);
            }
          }
          if (!topic && d.message?.role === "user") {
            const content = d.message.content;
            if (typeof content === "string" && content.trim()) {
              topic = content.trim().slice(0, 80);
            }
          }
          if (sessionMeta && topic) break;
        } catch { /* skip */ }
      }
      rl.close();
      stream.destroy();
    } catch { /* skip */ }

    const resolvedCwd = sessionMeta?.cwd || cwd;
    return {
      session_id: fileInfo.sessionId,
      display_name: topic || "(空)",
      last_active: fileInfo.mtime,
      backend: "codex",
      cwd: resolvedCwd,
      project_name: basename(resolvedCwd) || resolvedCwd,
      session_source: detectSessionSource(sessionMeta || {}),
      originator: sessionMeta?.originator || "",
    };
  }

  function normalizeTranscriptText(value, maxLen = 200) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > maxLen ? `${text.slice(0, maxLen - 3)}...` : text;
  }

  async function inspectSessionFile(fileInfo, limit = 6) {
    const meta = await parseSessionFile(fileInfo);
    const messages = [];

    try {
      const stream = createReadStream(fileInfo.path, { encoding: "utf8" });
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);

          if (d.type === "event_msg" && d.payload?.type === "user_message") {
            const text = normalizeTranscriptText(d.payload.message);
            if (text) messages.push({ role: "user", text });
            continue;
          }

          if (d.type === "event_msg" && d.payload?.type === "agent_message") {
            const text = normalizeTranscriptText(d.payload.message);
            if (text) messages.push({ role: "assistant", text });
            continue;
          }

          if (d.message?.role === "user" || d.message?.role === "assistant") {
            const content = d.message.content;
            const text =
              typeof content === "string"
                ? normalizeTranscriptText(content)
                : normalizeTranscriptText(content?.text);
            if (text) messages.push({ role: d.message.role, text });
          }
        } catch {
          // skip malformed lines
        }
      }
      rl.close();
      stream.destroy();
    } catch {
      // skip transcript preview if file cannot be read
    }

    const deduped = [];
    for (const msg of messages) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.role === msg.role && prev.text === msg.text) continue;
      deduped.push(msg);
    }

    return {
      ...meta,
      preview_messages: deduped.slice(-limit),
    };
  }

  return {
    name: "codex",
    label: "Codex",
    icon: "🟢",

    availableModels() {
      return [
        { id: "__default__", label: `默认${defaultModel ? ` (${defaultModel})` : "（跟随 Codex 配置）"}` },
        { id: "o3", label: "o3" },
        { id: "o4-mini", label: "o4-mini" },
        { id: "codex-mini", label: "Codex Mini" },
      ];
    },

    availableEfforts() {
      return [
        { id: "__default__", label: "默认 (medium)", description: "标准思考深度" },
        { id: "minimal", label: "Minimal", description: "最快速，极简思考" },
        { id: "low", label: "Low", description: "轻量思考" },
        { id: "medium", label: "Medium ✦", description: "标准思考深度" },
        { id: "high", label: "High", description: "深度思考" },
        { id: "xhigh", label: "XHigh", description: "最深度思考" },
      ];
    },

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      const effectiveModel = (overrides.model && overrides.model !== "__default__") ? overrides.model : defaultModel;
      const sdk = ensureSDK(effectiveModel);

      const effectiveCwd = overrides.cwd || cwd;
      const threadOpts = { workingDirectory: effectiveCwd, skipGitRepoCheck: true };
      if (overrides.effort) {
        threadOpts.modelReasoningEffort = overrides.effort;
      }
      const thread = sessionId
        ? sdk.resumeThread(sessionId, threadOpts)
        : sdk.startThread(threadOpts);

      // runStreamed 支持 signal 取消
      const turnOpts = abortSignal ? { signal: abortSignal } : {};
      const { events } = await thread.runStreamed(prompt, turnOpts);

      let yieldedInit = false;
      let lastAgentMessage = ""; // 累积最后的 agent_message 文本

      for await (const event of events) {
        // thread.started 事件包含 thread_id
        if (event.type === "thread.started") {
          yield { type: "session_init", sessionId: event.thread_id };
          yieldedInit = true;
        }

        // 首次拿到 thread.id 时兜底发 session_init
        if (!yieldedInit && thread.id) {
          yield { type: "session_init", sessionId: thread.id };
          yieldedInit = true;
        }

        if (event.type === "item.completed") {
          const item = event.item;
          // agent_message 是最终回复文本，累积它
          if (item.type === "agent_message") {
            lastAgentMessage = item.text || "";
          }
          yield {
            type: "progress",
            toolName: summarizeItemName(item),
            detail: summarizeItemDetail(item),
          };
        }

        if (event.type === "turn.completed") {
          // turn.completed 只有 usage，最终文本从 agent_message 累积
          yield {
            type: "result",
            success: true,
            text: lastAgentMessage,
            cost: null,
            duration: null,
          };
        }

        if (event.type === "turn.failed") {
          yield {
            type: "result",
            success: false,
            text: event.error?.message || "Codex turn failed",
            cost: null,
            duration: null,
          };
        }

        if (event.type === "error") {
          yield {
            type: "result",
            success: false,
            text: event.error?.message || "Codex stream error",
            cost: null,
            duration: null,
          };
        }
      }

      // 安全兜底：如果 events 全部消费完但没发过 session_init
      if (!yieldedInit && thread.id) {
        yield { type: "session_init", sessionId: thread.id };
      }
    },

    statusInfo(overrideModel) {
      const m = overrideModel || defaultModel;
      return {
        model: m || "(default)",
        cwd,
        mode: "Codex SDK direct",
      };
    },

    async listSessions(limit = 10) {
      const recent = listRecentSessionFiles(limit);
      const results = [];
      for (const s of recent) {
        results.push(await parseSessionFile(s));
      }
      return results;
    },

    async resolveSession(sessionId) {
      const fileInfo = findSessionFile(sessionId);
      if (!fileInfo) return null;
      return await parseSessionFile(fileInfo);
    },

    async inspectSession(sessionId, options = {}) {
      const fileInfo = findSessionFile(sessionId);
      if (!fileInfo) return null;
      return await inspectSessionFile(fileInfo, options.limit || 6);
    },
  };
}

// Codex ThreadItem types:
// agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, todo_list, error
function summarizeItemName(item) {
  if (!item) return "action";
  switch (item.type) {
    case "command_execution": return "Bash";
    case "file_change": return "Edit";
    case "mcp_tool_call": return item.tool || "MCP";
    case "web_search": return "WebSearch";
    case "agent_message": return "message";
    case "reasoning": return "reasoning";
    case "todo_list": return "todo";
    case "error": return "error";
    default: return item.type || "action";
  }
}

function summarizeItemDetail(item) {
  if (!item) return "";
  switch (item.type) {
    case "command_execution": return (item.command || "").slice(0, 60);
    case "file_change": return (item.changes || []).map((c) => c.path).join(", ").slice(0, 60);
    case "mcp_tool_call": return `${item.server}/${item.tool}`;
    case "web_search": return (item.query || "").slice(0, 60);
    case "agent_message": return (item.text || "").slice(0, 60);
    case "reasoning": return (item.text || "").slice(0, 60);
    default: return "";
  }
}
