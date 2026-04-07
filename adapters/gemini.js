// Gemini Code Assist 适配器（OAuth 直连，复用 Pro 订阅）
// 走 cloudcode-pa.googleapis.com，不走标准 generativelanguage API
// OAuth token 从 ~/.gemini/oauth_creds.json 读取，自动刷新

import { OAuth2Client } from "google-auth-library";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// Gemini CLI 公开的 OAuth Client（installed app，非秘密）
// 从环境变量读取，避免 GitHub push protection 误拦
const OAUTH_CLIENT_ID = process.env.GEMINI_OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.GEMINI_OAUTH_CLIENT_SECRET || "";

const CODE_ASSIST_ENDPOINT =
  process.env.CODE_ASSIST_ENDPOINT || "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION =
  process.env.CODE_ASSIST_API_VERSION || "v1internal";
const OAUTH_CREDS_PATH = join(process.env.HOME, ".gemini/oauth_creds.json");

export function createAdapter(config = {}) {
  const defaultModel =
    config.model || process.env.GEMINI_MODEL || "gemini-2.5-pro";
  const proxy = process.env.HTTPS_PROXY || null;

  let client = null;
  let projectId = null;

  // 会话历史：sessionId → Content[]
  const sessionHistory = new Map();

  async function ensureAuth() {
    if (client && projectId) return;

    if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
      throw new Error(
        "请在 config.json 或环境变量中设置 GEMINI_OAUTH_CLIENT_ID 和 GEMINI_OAUTH_CLIENT_SECRET"
      );
    }

    let creds;
    try {
      creds = JSON.parse(readFileSync(OAUTH_CREDS_PATH, "utf-8"));
    } catch {
      throw new Error(
        `无法读取 ${OAUTH_CREDS_PATH}，请先运行 gemini 登录`
      );
    }

    client = new OAuth2Client({
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET,
      ...(proxy && { transporterOptions: { proxy } }),
    });
    client.setCredentials(creds);

    // 验证 token 可用（会自动刷新）
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("OAuth token 获取失败");

    // loadCodeAssist 获取 projectId
    projectId = await loadProjectId(token);
  }

  async function loadProjectId(accessToken) {
    const envProject =
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (envProject) return envProject;

    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`loadCodeAssist 失败 (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (data.cloudaicompanionProject) return data.cloudaicompanionProject;

    // 尝试 onboard
    if (!data.currentTier) {
      const tier = (data.allowedTiers || []).find((t) => t.isDefault);
      if (tier) {
        const onboardRes = await fetch(
          `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:onboardUser`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              tierId: tier.id,
              metadata: {
                ideType: "IDE_UNSPECIFIED",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
              },
            }),
          }
        );
        const onboard = await onboardRes.json();
        if (onboard.response?.cloudaicompanionProject?.id) {
          return onboard.response.cloudaicompanionProject.id;
        }
      }
    }

    throw new Error(
      "无法获取 project ID。请设置 GOOGLE_CLOUD_PROJECT 环境变量或确认 Gemini Pro 订阅状态。"
    );
  }

  async function getToken() {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("OAuth token 过期且无法刷新");
    return token;
  }

  function getBaseUrl() {
    return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;
  }

  return {
    name: "gemini",
    label: "Gemini",
    icon: "🔵",

    availableModels() {
      return [
        { id: "__default__", label: `默认 (${defaultModel})` },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
      ];
    },

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      await ensureAuth();
      const model = (overrides.model && overrides.model !== "__default__") ? overrides.model : defaultModel;

      const sid = sessionId || randomUUID();
      yield { type: "session_init", sessionId: sid };

      // 获取或创建会话历史
      const history = sessionHistory.get(sid) || [];
      history.push({ role: "user", parts: [{ text: prompt }] });

      const token = await getToken();
      const url = `${getBaseUrl()}:streamGenerateContent?alt=sse`;
      const body = {
        model,
        project: projectId,
        user_prompt_id: randomUUID(),
        request: {
          contents: history,
          generationConfig: {
            // 默认不设 temperature，用服务端默认
          },
          session_id: sid,
        },
      };

      const startTime = Date.now();
      const MAX_RETRIES = 3;
      let res;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal: abortSignal,
        });

        if (res.ok) break;

        // 429/503 自动重试
        if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
          const wait = (attempt + 1) * 5; // 5s, 10s, 15s
          console.log(`[Gemini] ${res.status} 容量不足，${wait}s 后重试 (${attempt + 1}/${MAX_RETRIES})`);
          yield { type: "progress", toolName: "retry", detail: `服务端繁忙，${wait}s 后重试...` };
          await new Promise(r => setTimeout(r, wait * 1000));
          continue;
        }

        const errText = await res.text();
        yield {
          type: "result",
          success: false,
          text: `Gemini API 错误 (${res.status}): ${errText.slice(0, 200)}`,
          cost: null,
          duration: null,
        };
        return;
      }

      // 解析 SSE 流
      let fullText = "";
      let usageMetadata = null;

      for await (const chunk of parseSSE(res.body)) {
        const candidates = chunk.response?.candidates || chunk.candidates;
        if (!candidates || !candidates.length) continue;

        const parts = candidates[0].content?.parts;
        if (!parts) continue;

        for (const part of parts) {
          if (part.text) {
            fullText += part.text;
            yield { type: "text", text: part.text };
          }
        }

        // 进度事件
        const finishReason = candidates[0].finishReason;
        if (finishReason && finishReason !== "STOP") {
          yield {
            type: "progress",
            toolName: "generation",
            detail: `finishReason: ${finishReason}`,
          };
        }

        if (chunk.response?.usageMetadata || chunk.usageMetadata) {
          usageMetadata = chunk.response?.usageMetadata || chunk.usageMetadata;
        }
      }

      // 保存助手回复到历史
      if (fullText) {
        history.push({ role: "model", parts: [{ text: fullText }] });
      }
      sessionHistory.set(sid, history);

      // 限制历史长度，避免内存膨胀
      if (history.length > 40) {
        const trimmed = history.slice(-30);
        sessionHistory.set(sid, trimmed);
      }

      const duration = Date.now() - startTime;
      yield {
        type: "result",
        success: true,
        text: fullText,
        cost: null,
        duration,
      };
    },

    statusInfo(overrideModel) {
      return {
        model: overrideModel || defaultModel,
        cwd: process.env.HOME,
        mode: "Code Assist OAuth (Pro)",
      };
    },

    async listSessions(limit = 10) {
      // 扫描 Gemini CLI 的本地 session 文件：~/.gemini/tmp/*/chats/session-*.json
      const geminiTmp = join(process.env.HOME, ".gemini", "tmp");
      const allFiles = [];

      try {
        const projectDirs = readdirSync(geminiTmp).filter(d => {
          try { return statSync(join(geminiTmp, d)).isDirectory(); } catch { return false; }
        });
        for (const dir of projectDirs) {
          const chatsDir = join(geminiTmp, dir, "chats");
          try {
            const files = readdirSync(chatsDir)
              .filter(f => f.startsWith("session-") && f.endsWith(".json"))
              .map(f => {
                const fp = join(chatsDir, f);
                const stat = statSync(fp);
                return { file: f, path: fp, mtime: stat.mtimeMs, size: stat.size };
              });
            allFiles.push(...files);
          } catch { /* skip */ }
        }
      } catch { return null; }

      if (!allFiles.length) return null;
      allFiles.sort((a, b) => b.mtime - a.mtime);
      const recent = allFiles.slice(0, limit);

      const results = [];
      for (const s of recent) {
        let topic = "";
        let sessionId = "";
        try {
          const data = JSON.parse(readFileSync(s.path, "utf8"));
          sessionId = data.sessionId || s.file.replace(".json", "");
          const msgs = data.messages || [];
          for (const m of msgs) {
            if (m.type === "user") {
              const content = m.content;
              if (Array.isArray(content)) {
                const txt = content.find(c => typeof c === "object" && c.text);
                if (txt) topic = txt.text.slice(0, 80);
              } else if (typeof content === "string") {
                topic = content.slice(0, 80);
              }
              if (topic) break;
            }
          }
        } catch { /* skip */ }

        results.push({
          session_id: sessionId || s.file.replace(".json", ""),
          display_name: topic || "(空)",
          last_active: s.mtime,
          backend: "gemini",
        });
      }
      return results;
    },
  };
}

// SSE 流解析器
async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let dataLines = [];
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          dataLines.push(line.slice(6).trim());
        } else if (line === "" && dataLines.length > 0) {
          try {
            yield JSON.parse(dataLines.join("\n"));
          } catch {
            // 忽略解析错误
          }
          dataLines = [];
        }
      }

      // SSE chunk 内 data 行后无空行时也尝试解析
      if (dataLines.length > 0) {
        try {
          yield JSON.parse(dataLines.join("\n"));
        } catch {
          // 可能还在缓冲中
        }
      }
    }

    // 处理缓冲区剩余
    if (buffer.startsWith("data: ")) {
      try {
        yield JSON.parse(buffer.slice(6).trim());
      } catch {
        // 忽略
      }
    }
  } finally {
    reader.releaseLock();
  }
}
