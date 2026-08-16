<div align="center">

# wechat-ai-bridge

**Claude Code and Codex. In WeChat Private Chat.**

*Run local Claude Code or Codex agent sessions from WeChat, with Claude tool approval and file relay.*

A self-hosted bridge that uses WeChat's iLink bot endpoints. The WeChat transport itself needs no separate tunnel where iLink is available; each AI backend still needs its normal network access and account eligibility.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](https://github.com/AliceLJY/wechat-ai-bridge/releases)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![WeChat](https://img.shields.io/badge/Interface-WeChat-07C160?logo=wechat)](https://weixin.qq.com/)

**English** | [简体中文](README_CN.md)

</div>

> **How is this different from cc-weixin / wechat-acp?**
>
> This project focuses on **session management** (`/new` `/resume` `/sessions`), **backend selection** (Claude + Codex), **Claude tool approval**, and **bidirectional file relay** — the same workflow family as [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge), now using WeChat transport.

> **On the `gemini` backend — do not use it on a personal account.**
>
> This adapter calls the internal Code Assist endpoint `cloudcode-pa.googleapis.com`
> and reads its OAuth token from `~/.gemini/oauth_creds.json`, a file written by the
> standalone `gemini` CLI login. Google retired that CLI for personal accounts
> (free, AI Pro, AI Ultra) on 2026-06-18, so the file is no longer produced and the
> adapter cannot authenticate. Its successor, the Antigravity CLI (`agy`), does not
> write a drop-in replacement for it.
>
> Separately — and this matters more than the breakage — Google has stated that using
> Gemini CLI OAuth credentials from third-party software is a policy-violating use
> case that may trigger abuse detection or account restrictions. Do not point this
> adapter at credentials obtained that way. The code is kept for Code Assist
> Standard/Enterprise deployments that authenticate through their own supported path.
>
> Claude and Codex backends are unaffected.

---

## What This Unlocks

### Local Coding Agents from WeChat

Send a message in WeChat and run a Claude Code or Codex turn on the bridge host. Available tools and filesystem access come from the selected SDK/CLI and its local configuration. The workflow requires WeChat/iLink and the selected model provider to be reachable.

### Session Management

```
你: /new              ← Start a fresh session
你: /sessions         ← List recent sessions
你: /resume 3         ← Pick up where you left off
你: /backend codex    ← Switch backend
你: /model            ← Switch models (reply with number)
```

Bridge session mappings and preferences persist in SQLite. Claude and Codex sessions can be discovered from their local session stores and resumed after restart. The experimental Gemini adapter keeps its conversation history in memory, so that history does not survive a bridge restart. `/sessions` lists sessions discoverable for the active backend; resume by number with `/resume 3`.

### Multi-Backend Support

| Backend | Integration and capability | Status |
|---------|----------------------------|--------|
| `claude` | Agent SDK + local Claude executable; agent tools, resumable sessions, bridge-mediated tool approval | Recommended |
| `codex` | Codex SDK/CLI; agent tools and resumable threads, without bridge-mediated approval prompts | Recommended |
| `gemini` | Google Code Assist API text generation with in-memory history; no local tool execution | Retired for personal accounts — see note below |

Select the backend at startup with `--backend`. `/backend` can switch only among adapters explicitly loaded by an advanced multi-adapter deployment.

### Claude Tool Approval via Chat

When the Claude backend asks for permission to run a tool:

```
🔒 工具审批

工具: Bash
git push origin main

请回复数字:
1. 允许
2. 拒绝
3. 始终允许 "Bash"
4. YOLO（全部允许）
```

Reply `1`, `2`, `3`, or `4`. No buttons needed — just text.

### Bidirectional File Relay

- **Send photos/files to Claude or Codex**: WeChat media is downloaded, decrypted (AES-128-ECB), stored under local `files/` with a sanitized portable filename, and passed to the agent as a local path
- **Receive files from Claude or Codex**: detected local output files and screenshots are sent only when both their lexical and real paths resolve to a regular file under that chat's current working directory. Hidden paths, control characters, common auth/config/credential/key/log/OAuth/secret/session/token names, symlink escapes, oversized files, and inbound `files/` uploads are rejected before reading.
- **Long output**: messages over 2000 chars are auto-split into multiple messages, with code fences kept intact

The experimental Gemini text backend cannot read the downloaded local file by itself because it has no local tools.

### Data and Trust Boundaries

- **Local by default**: bridge config, token, SQLite session/task mappings, and decrypted inbound file copies are stored on the bridge host.
- **Fail-closed sender authorization**: only exact iLink `from_user_id` values listed in `shared.allowedUserIds` are processed. Unknown senders are rejected before media download, approval handling, commands, or model calls.
- **WeChat transport**: messages and context tokens pass through iLink endpoints; media is downloaded from or uploaded to the WeChat CDN.
- **Model providers**: prompts and any context selected by the agent follow the data handling of the configured Claude, OpenAI, or Google backend. They do not remain exclusively on the bridge host.
- **Host access**: this bridge is not a sandbox. Claude Code and Codex run with the filesystem and process permissions granted to their local CLI/SDK configuration. Bridge-mediated tool approval currently applies only to Claude.

### Built-in Resilience

- **Rate limiting**: Per-user sliding window
- **Idle monitoring**: Watchdog timer for hung tasks
- **Message batching**: FlushGate merges rapid consecutive messages (800ms window)
- **Send retry**: Exponential backoff with error classification
- **File reference protection**: Prevents auto-linking of `.md`, `.go`, `.py` filenames

---

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) runtime, WeChat version >= 2026.3.20, and at least one backend CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex](https://openai.com/index/codex/).

```bash
git clone https://github.com/AliceLJY/wechat-ai-bridge.git
cd wechat-ai-bridge
npm install              # or: bun install
bun run bootstrap --backend claude
# Edit config.json and set shared.allowedUserIds to verified iLink from_user_id values.
bun run check --backend claude
bun run start --backend claude
```

On first launch, a QR code appears in your terminal. Scan it with WeChat to authenticate. Token is saved to `~/.wechat-ai-bridge/token.json` for subsequent launches.

`shared.allowedUserIds` is required and starts empty. Use exact, independently verified iLink `from_user_id` strings—not a display name, WeChat alias, or guessed value. The bridge never auto-claims the first contact. Validation fails while the list is empty; rejected sender IDs are written only to the local process log and are never added automatically. `start.js` serializes the configured list into the internal `WECHAT_ALLOWED_USER_IDS` environment variable before loading the bridge.

On POSIX hosts, the bridge enforces mode `0600` on `config.json` and `~/.wechat-ai-bridge/token.json`, and mode `0700` on `~/.wechat-ai-bridge/` and the inbound `files/` directory. It refuses symbolic links for these private paths; Windows deployments should also restrict these paths with local ACLs.

---

## WeChat Commands

All commands are plain text — just type and send:

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/new` | Start a new session |
| `/cancel` | Abort the running task |
| `/sessions` | List recent sessions |
| `/resume <#\|id>` | Resume by sequence number or session ID |
| `/backend [name]` | Switch backend (claude/codex/gemini) |
| `/model [name]` | Pick a model (reply with number) |
| `/effort [level]` | Set thinking depth |
| `/status` | Show backend, model, cwd, session |
| `/dir [path|-]` | Switch working directory; `-` returns to the previous directory |
| `/verbose 0\|1\|2` | Change progress verbosity |

---

## How It Works

```
WeChat App ←→ iLink Server (ilinkai.weixin.qq.com) ←→ wechat-ai-bridge ←→ AI Backend
                                                         │
                                                         ├── weixin/     (iLink connection)
                                                         ├── adapters/   (Claude/Codex/Gemini)
                                                         ├── sessions.js (SQLite persistence)
                                                         └── bridge.js   (core message loop)
```

The bridge uses WeChat **iLink bot endpoints**. Communication is HTTP/JSON with long-polling (`getupdates`), similar to Telegram's Bot API. Media files use the protocol's AES-128-ECB encryption before CDN upload.

The source code can show which endpoints it calls, but it cannot guarantee platform status, account eligibility, continued availability, or zero enforcement risk. Check the current WeChat terms that apply to your account and deployment.

---

## vs. Existing Projects

| Feature | cc-weixin | wechat-acp | This project |
|---------|-----------|------------|-------------|
| AI backends | Claude only | 6 via ACP | Claude + Codex agents |
| Session management | None | None | `/new` `/resume` `/sessions` `/backend` |
| Tool approval | Auto-allow | Auto-allow | Interactive for Claude; no bridge approval prompt for Codex/Gemini |
| Model switching | Hardcoded | Per-preset | `/model` with numbered selection |
| File relay (in) | Text only | Images+files | Local-path relay for tool-capable Claude/Codex backends |
| File relay (out) | None | None | Auto-detect local paths + encrypted WeChat CDN upload |
| Rate limiting | None | None | Per-user sliding window |
| Idle monitoring | None | None | Watchdog + auto-reset |
| Message batching | None | None | FlushGate (800ms merge) |
| Cross-platform sessions | None | None | Discover local Claude/Codex sessions (CLI + other bridges) |

Comparison entries describe the projects as reviewed on 2026-07-17 and may change upstream.

---

<details>
<summary><strong>Configuration</strong></summary>

`bun run bootstrap --backend claude` generates a starter `config.json`.

```json
{
  "shared": {
    "cwd": "/Users/you",
    "allowedUserIds": ["replace-with-verified-from_user_id"],
    "defaultVerboseLevel": 1,
    "executor": "direct",
    "rateLimitMaxRequests": 10,
    "rateLimitWindowMs": 60000,
    "idleTimeoutMs": 1800000
  },
  "backends": {
    "claude": {
      "enabled": true,
      "sessionsDb": "sessions.db",
      "model": "claude-sonnet-4-7",
      "permissionMode": "default"
    }
  }
}
```

</details>

<details>
<summary><strong>Project Structure</strong></summary>

- `start.js` — CLI entry with QR login flow
- `config.js` — Config loader and setup wizard
- `bridge.js` — Core message loop
- `progress.js` — Typing indicator + processing status
- `sessions.js` — SQLite session persistence
- `weixin/api.js` — iLink HTTP client
- `weixin/auth.js` — QR code login + token persistence
- `weixin/monitor.js` — Long-polling message listener
- `weixin/send.js` — Message sending + text chunking
- `weixin/media.js` — CDN upload/download + AES-128-ECB
- `inbound-files.js` — Portable filename sanitization + download containment
- `runtime-paths.js` — Cross-platform home-directory resolution
- `weixin/types.js` — iLink protocol constants
- `adapters/` — AI backend integrations (Claude/Codex/Gemini)
- `executor/` — Execution modes

</details>

<details>
<summary><strong>iLink Protocol Notes</strong></summary>

- **Authentication**: QR code scan → `bot_token` (persisted locally to `~/.wechat-ai-bridge/token.json`)
- **Message flow**: `getupdates` long-poll (35s hold) → process → `sendmessage` with `context_token`
- **Media**: AES-128-ECB encrypted CDN (`novac2c.cdn.weixin.qq.com`)
- **Limitation**: 1 WeChat account = 1 bot (1:1 binding)
- **No group chat**: the current bridge supports private messaging only
- **Policy boundary**: endpoint availability and account eligibility remain subject to current WeChat terms

</details>

---

## Adding Custom Backends

The adapter interface is designed for easy extension. To add a new AI backend (e.g. [OpenCode](https://opencode.ai/), [Crush](https://github.com/charmbracelet/crush), or any CLI agent):

1. Create `adapters/yourbackend.js` exporting `createAdapter(config)`:

```js
export function createAdapter(config = {}) {
  return {
    name: "yourbackend",
    async *streamQuery({ prompt, sessionId, model, cwd, abortController }) {
      yield { type: "session_init", sessionId: "..." };
      yield { type: "text", text: "response chunk" };
      yield { type: "result", success: true, text: "final answer" };
    },
    statusInfo() {
      return { backend: "yourbackend", model: "...", session: "..." };
    }
  };
}
```

2. Register it in `adapters/interface.js` and add the name to `AVAILABLE_BACKENDS` in `config.js`.

Event types: `session_init` | `progress` (tool use indicators) | `text` (streaming chunks) | `result` (final).

> **Community interest**: OpenCode / Crush support has been requested. OpenCode offers a [JS/TS SDK](https://opencode.ai/docs/sdk/) (`@opencode-ai/sdk`); Crush provides a [Unix socket REST API](https://github.com/charmbracelet/crush) with SSE streaming. PRs welcome!

---

## Ecosystem

Part of the **小试AI** open-source AI workflow:

| Project | Description |
|---------|-------------|
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | Same architecture, Telegram interface |
| [tg-bridge-channel](https://github.com/AliceLJY/tg-bridge-channel) | Sister bridge using Claude Agent View background sessions (channel/pool engine) |
| [recallnest](https://github.com/AliceLJY/recallnest) | MCP memory workbench |
| [openclaw-tunnel](https://github.com/AliceLJY/openclaw-tunnel) | Docker ↔ host CLI bridge |

## License

MIT
