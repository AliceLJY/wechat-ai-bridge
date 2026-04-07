// Claude Agent SDK 适配器
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, statSync, createReadStream } from "fs";
import { basename, join } from "path";
import { createInterface } from "readline";

export function createAdapter(config = {}) {
  const defaultModel = config.model || process.env.CC_MODEL || "claude-sonnet-4-6";
  const cwd = config.cwd || process.env.CC_CWD || process.env.HOME;
  const permMode = process.env.CC_PERMISSION_MODE || "default";

  // Claude SDK 不支持并发 query()（两个子进程会冲突），用锁串行化
  let queryQueue = Promise.resolve();

  function listSessionFiles(limit = 10) {
    const projectsDir = join(process.env.HOME, ".claude", "projects");
    const allFiles = [];

    try {
      const dirs = readdirSync(projectsDir).filter(d => {
        try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
      });
      for (const dir of dirs) {
        const fullDir = join(projectsDir, dir);
        try {
          const files = readdirSync(fullDir)
            .filter(f => f.endsWith(".jsonl"))
            .map(f => {
              const fp = join(fullDir, f);
              const stat = statSync(fp);
              return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size, sessionId: f.replace(".jsonl", "") };
            });
          allFiles.push(...files);
        } catch { /* skip */ }
      }
    } catch {
      return [];
    }

    allFiles.sort((a, b) => b.mtime - a.mtime);
    return allFiles.slice(0, limit);
  }

  function findSessionFile(sessionId) {
    const projectsDir = join(process.env.HOME, ".claude", "projects");
    try {
      const dirs = readdirSync(projectsDir);
      for (const dir of dirs) {
        const fullDir = join(projectsDir, dir);
        try {
          if (!statSync(fullDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const match = readdirSync(fullDir).find(f => f === `${sessionId}.jsonl`);
        if (match) {
          const path = join(fullDir, match);
          const stat = statSync(path);
          return { file: match, path, mtime: stat.mtimeMs, size: stat.size, sessionId };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  async function parseSessionFile(fileInfo) {
    let topic = "";
    let resolvedCwd = "";

    try {
      const stream = createReadStream(fileInfo.path, { encoding: "utf8" });
      const rl = createInterface({ input: stream });
      for await (const line of rl) {
        try {
          const d = JSON.parse(line);
          if (!resolvedCwd && typeof d.cwd === "string" && d.cwd) {
            resolvedCwd = d.cwd;
          }
          if (d.message?.role === "user") {
            const content = d.message.content;
            if (Array.isArray(content)) {
              const txt = content.find(c => typeof c === "object" && c.type === "text");
              if (txt?.text) topic = txt.text.slice(0, 80);
            } else if (typeof content === "string") {
              topic = content.slice(0, 80);
            }
            if (topic && !topic.startsWith("[Request interrupted")) break;
            topic = "";
          }
        } catch { /* skip */ }
      }
      rl.close();
      stream.destroy();
    } catch { /* skip */ }

    const finalCwd = resolvedCwd || cwd;
    return {
      session_id: fileInfo.sessionId,
      display_name: topic || "(空)",
      last_active: fileInfo.mtime,
      backend: "claude",
      cwd: finalCwd,
      project_name: basename(finalCwd) || finalCwd,
      session_source: "CLI",
    };
  }

  return {
    name: "claude",
    label: "CC",
    icon: "🟣",

    availableModels() {
      return [
        { id: "__default__", label: `默认 (${defaultModel})` },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
        { id: "claude-opus-4-6", label: "Opus 4.6" },
        { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      ];
    },

    availableEfforts() {
      return [
        { id: "__default__", label: "默认 (high)", description: "标准思考深度" },
        { id: "low", label: "Low", description: "最快速，轻量思考" },
        { id: "medium", label: "Medium", description: "中等思考深度" },
        { id: "high", label: "High ✦", description: "标准深度思考" },
        { id: "max", label: "Max", description: "最深度思考（仅 Opus）" },
      ];
    },

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      // 排队等前一个 query 完成（Claude SDK 不支持并发子进程）
      let releaseLock;
      const myLock = new Promise((r) => { releaseLock = r; });
      const waitForTurn = queryQueue;
      queryQueue = myLock;
      await waitForTurn;

      const {
        requestPermission,
        allowedTools: overrideAllowedTools,
        permissionMode: overridePermMode,
        persistSession: overridePersistSession,
        maxTurns: overrideMaxTurns,
        effort: overrideEffort,
        ...restOverrides
      } = overrides;
      const model = (restOverrides.model && restOverrides.model !== "__default__") ? restOverrides.model : defaultModel;
      const effectivePermMode = overridePermMode || permMode;
      const effectiveCwd = restOverrides.cwd || cwd;
      const options = {
        model,
        permissionMode: effectivePermMode,
        ...(effectivePermMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
        cwd: effectiveCwd,
        ...(overrideEffort ? { effort: overrideEffort } : {}),
      };

      // A2A overrides: allowedTools, persistSession, maxTurns
      if (overrideAllowedTools) options.allowedTools = overrideAllowedTools;
      if (overridePersistSession !== undefined) options.persistSession = overridePersistSession;
      if (overrideMaxTurns !== undefined) options.maxTurns = overrideMaxTurns;

      // Tool approval: forward permission requests to Telegram
      if (requestPermission && effectivePermMode !== "bypassPermissions") {
        options.canUseTool = async (toolName, input, sdkOptions) => {
          return await requestPermission(toolName, input, sdkOptions);
        };
      }

      if (sessionId) {
        options.resume = sessionId;
      } else {
        options.settingSources = ["user", "project"];
      }

      // Claude SDK 需要 AbortController 对象，bridge 传来的是 AbortSignal
      const abortController = new AbortController();
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });
      }

      // 捕获 SDK 子进程 stderr，用于排查 exit code 1
      options.stderr = (data) => console.error(`[Claude SDK stderr] ${data}`);

      console.log(`[Claude SDK] query() options: ${JSON.stringify({
        model: options.model,
        permissionMode: options.permissionMode,
        cwd: options.cwd,
        effort: options.effort || null,
        resume: options.resume || null,
        settingSources: options.settingSources || null,
        allowedTools: options.allowedTools || null,
        persistSession: options.persistSession,
        maxTurns: options.maxTurns,
        hasCanUseTool: !!options.canUseTool,
      })}`);

      try {
        yield* this._runQuery(prompt, options, abortController);
      } catch (err) {
        // resume session 失败（thinking signature 过期等）→ 回退到新 session
        if (options.resume && /invalid.*signature|invalid_request_error/i.test(err.message)) {
          console.log(`[Claude SDK] resume failed (${err.message.slice(0, 80)}), retrying as new session`);
          const freshOptions = { ...options };
          delete freshOptions.resume;
          freshOptions.settingSources = ["user", "project"];
          yield* this._runQuery(prompt, freshOptions, abortController);
        } else {
          throw err;
        }
      } finally {
        releaseLock();
      }
    },

    async *_runQuery(prompt, options, abortController) {
      for await (const msg of query({
        prompt,
        options: { ...options, abortController },
      })) {

        if (msg.type === "system" && msg.subtype === "init") {
          yield { type: "session_init", sessionId: msg.session_id };
        }

        if (msg.type === "assistant" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              if (block.name === "AskUserQuestion" && block.input?.questions) {
                for (const q of block.input.questions) {
                  yield {
                    type: "question",
                    question: q.question || "",
                    header: q.header || "",
                    options: (q.options || []).map(o => ({
                      label: o.label,
                      description: o.description || "",
                    })),
                    multiSelect: q.multiSelect || false,
                  };
                }
              }

              // 从 Write/Edit 输入提取文件路径
              if ((block.name === "Write" || block.name === "Edit") && block.input?.file_path) {
                yield { type: "file_written", filePath: block.input.file_path, tool: block.name };
              }
              // 从 Bash 命令中提取输出文件路径
              if (block.name === "Bash" && block.input?.command) {
                const cmd = block.input.command;
                const fileExts = "png|jpg|jpeg|gif|webp|pdf|docx|xlsx|svg";
                // cp/mv 目标路径
                const destRe = new RegExp(`(?:cp|mv)\\s+.*?((?:\\/|~\\/)[^\\s"']+\\.(?:${fileExts}))`, "gi");
                let dm;
                while ((dm = destRe.exec(cmd)) !== null) {
                  yield { type: "file_written", filePath: dm[1], tool: "Bash" };
                }
                // screencapture 输出路径（macOS）
                const scRe = new RegExp(`screencapture\\s+[^\\s]*\\s*((?:\\/|~\\/)[^\\s"']+\\.(?:${fileExts}))`, "gi");
                while ((dm = scRe.exec(cmd)) !== null) {
                  yield { type: "file_written", filePath: dm[1], tool: "Bash" };
                }
                // 通用：命令末尾的文件路径参数（兜底）
                const tailRe = new RegExp(`((?:\\/|~\\/)(?:[\\w.\\-]+\\/)*[\\w.\\-\\u4e00-\\u9fff]+\\.(?:${fileExts}))\\s*$`, "gi");
                while ((dm = tailRe.exec(cmd)) !== null) {
                  yield { type: "file_written", filePath: dm[1], tool: "Bash" };
                }
              }
              yield {
                type: "progress",
                toolName: block.name,
                input: block.input,
              };
            } else if (block.type === "text" && block.text) {
              yield { type: "text", text: block.text };
            }
          }
        }

        // 捕获工具结果中的图片（SDKUserMessage）
        if (msg.type === "user") {
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              // tool_result 嵌套内容
              if (block.type === "tool_result" && Array.isArray(block.content)) {
                for (const part of block.content) {
                  if (part.type === "image" && part.source?.data) {
                    yield {
                      type: "image",
                      data: part.source.data,
                      mediaType: part.source.media_type || "image/png",
                      toolUseId: block.tool_use_id,
                    };
                  }
                }
              }
              // 顶层 image block
              if (block.type === "image" && block.source?.data) {
                yield {
                  type: "image",
                  data: block.source.data,
                  mediaType: block.source.media_type || "image/png",
                };
              }
            }
          }
        }

        // 捕获文件持久化事件
        if (msg.type === "system" && msg.subtype === "files_persisted") {
          for (const f of msg.files || []) {
            yield { type: "file_persisted", filename: f.filename, fileId: f.file_id };
          }
        }

        if (msg.type === "result") {
          const resultText = msg.subtype === "success" ? (msg.result || "") : (msg.errors || []).join("\n");
          console.log(`[Claude SDK] result: subtype=${msg.subtype} cost=${msg.total_cost_usd} text=${resultText.slice(0, 200)}`);

          // SDK 把 API 400 错误当 "success" 返回，需要检测并抛出让上层重试
          if (resultText.startsWith("API Error:") && /invalid.*signature|invalid_request_error/i.test(resultText)) {
            throw new Error(resultText);
          }

          yield {
            type: "result",
            success: msg.subtype === "success",
            text: resultText,
            cost: msg.total_cost_usd,
            duration: msg.duration_ms,
          };
          break;
        }
      }
    },

    statusInfo(overrideModel, overrideEffort) {
      return {
        model: overrideModel || defaultModel,
        effort: overrideEffort || null,
        cwd,
        mode: "Agent SDK direct",
      };
    },

    async listSessions(limit = 10) {
      const recent = listSessionFiles(limit);
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
  };
}
