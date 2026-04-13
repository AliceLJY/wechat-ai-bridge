// 微信进度显示模块
// 微信不支持 editMessage，只能发"处理中"+ typing 心跳

import { sendText, sendTyping, cancelTyping } from "./weixin/send.js";

const TOOL_ICONS = {
  Read: "📖", Write: "✍️", Edit: "✏️", Bash: "💻",
  Glob: "🔍", Grep: "🔎", WebFetch: "🌐", WebSearch: "🔍",
  Agent: "🤖", NotebookEdit: "📓",
};

const SILENT_TOOLS = new Set([
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
]);

const TYPING_INTERVAL_MS = 8000; // typing 心跳间隔

export function createProgressTracker(token, toUserId, contextToken, verboseLevel = 1, backendLabel = "CC") {
  let typingInterval = null;
  let typingTicket = "";
  let entries = [];
  let finished = false;

  async function start() {
    // 微信不能编辑/删除消息，不发文字进度提示（会永久留在聊天里）
    // 只用 typing 心跳（会自动消失）

    // Typing 心跳
    typingInterval = setInterval(() => {
      sendTyping(token, toUserId, contextToken, typingTicket).catch(() => {});
    }, TYPING_INTERVAL_MS);
    // 立刻发一次
    sendTyping(token, toUserId, contextToken, typingTicket).catch(() => {});
  }

  function processEvent(event) {
    if (finished || verboseLevel === 0) return;

    if (event.type === "progress") {
      const toolName = event.toolName || "action";
      if (SILENT_TOOLS.has(toolName)) return;
      const icon = TOOL_ICONS[toolName] || "🔧";

      let detail = "";
      if (event.input) {
        detail = typeof event.input === "object"
          ? (event.input.command || event.input.file_path || event.input.description || event.input.pattern || event.input.query || "").slice(0, 80)
          : (event.detail || "").slice(0, 80);
      }

      if (verboseLevel >= 2 && detail) {
        entries.push(`${icon} ${toolName}: ${detail}`);
      } else {
        // verboseLevel 1: 同名工具合并计数
        const lastEntry = entries[entries.length - 1] || "";
        const counterRe = new RegExp(`^${icon.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ${toolName}(?: x(\\d+))?$`);
        const m = lastEntry.match(counterRe);
        if (m) {
          const count = (parseInt(m[1]) || 1) + 1;
          entries[entries.length - 1] = `${icon} ${toolName} x${count}`;
        } else {
          entries.push(`${icon} ${toolName}`);
        }
      }

      // 终端实时日志：始终输出工具调用
      console.log(`  ${icon} ${toolName}${detail ? ": " + detail : ""}`);
    }

    if (event.type === "text" && event.text && verboseLevel >= 2) {
      const snippet = event.text.slice(0, 100).replace(/\n/g, " ");
      if (snippet.trim()) {
        entries.push(`💭 ${snippet}${event.text.length > 100 ? "..." : ""}`);
      }
    }
    // 微信不能编辑消息，工具进度只记录不实时更新
  }

  async function finish({ durationMs = 0 } = {}) {
    finished = true;

    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }

    // 取消 typing 状态
    cancelTyping(token, toUserId, contextToken, typingTicket).catch(() => {});
  }

  function getSummary(durationMs = 0) {
    if (entries.length === 0) return "";
    const toolCounts = {};
    for (const entry of entries) {
      const match = entry.match(/^\S+\s+(\w+)/);
      if (match && match[1]) toolCounts[match[1]] = (toolCounts[match[1]] || 0) + 1;
    }
    const toolSummary = Object.entries(toolCounts)
      .map(([name, count]) => `${name}${count > 1 ? ` x${count}` : ""}`)
      .join(", ");
    const durLabel = durationMs > 0 ? ` ${Math.round(durationMs / 1000)}s` : "";
    return `✅ Done${durLabel} — ${toolSummary || "no tools"}`;
  }

  return { start, processEvent, finish, getSummary };
}
