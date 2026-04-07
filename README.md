<div align="center">

# wechat-ai-bridge

**Full AI Coding Agents. In WeChat. Private Chat.**

*Run actual Claude Code / Codex / Gemini from WeChat — not an API wrapper — with session management, tool approval, and file relay.*

A self-hosted WeChat bridge that connects to AI coding agents via the official iLink Bot API. No VPN needed. Zero ban risk.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/AliceLJY/wechat-ai-bridge/releases)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![WeChat](https://img.shields.io/badge/Interface-WeChat-07C160?logo=wechat)](https://weixin.qq.com/)

**English** | [简体中文](README_CN.md)

</div>

> **How is this different from cc-weixin / wechat-acp?**
>
> They connect one AI backend with basic message forwarding. This project adds **session management** (`/new` `/resume` `/sessions`), **multi-backend switching** (Claude + Codex + Gemini), **tool approval interaction**, and **bidirectional file relay** — the same workflow you get from [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge), now in WeChat.

---

## What This Unlocks

### Full AI Agent in Your Pocket — No VPN

Send a message in WeChat. Get a full Claude Code response — with Bash, Read, Write, Edit, Glob, Grep, WebFetch, and all native tools. No terminal. No VPN. Works anywhere WeChat works.

### Session Management

```
你: /new              ← Start a fresh session
你: /sessions         ← List recent sessions
你: /resume 3         ← Pick up where you left off
你: /peek 5           ← Read-only preview
你: /model            ← Switch models (reply with number)
```

Sessions persist in SQLite across restarts. Pick up after a reboot, a network drop, or a flight.

### Multi-Backend Support

| Backend | SDK | Status |
|---------|-----|--------|
| `claude` | Claude Code (via Agent SDK) | Recommended |
| `codex` | Codex CLI (via Codex SDK) | Recommended |
| `gemini` | Gemini Code Assist API | Experimental |

Switch backends per chat with `/backend`.

### Tool Approval via Chat

When the AI needs permission to run a tool:

```
🔧 需要授权: Bash
命令: git push origin main

回复数字选择：
1. ✅ 允许（仅本次）
2. ✅ 始终允许（本会话）
3. ❌ 拒绝
4. 🔓 YOLO（全部放行）
```

Reply `1`, `2`, `3`, or `4`. No buttons needed — just text.

### Bidirectional File Relay

- **Send photos/files to AI**: WeChat media is downloaded, decrypted (AES-128-ECB), and injected into the prompt
- **Receive files from AI**: AI-generated files and screenshots are encrypted, uploaded to CDN, and sent back to your WeChat chat
- **Long code output**: >2000 chars with >60% code → sent as file attachment with preview

### Built-in Resilience

- **Rate limiting**: Per-user sliding window
- **Idle monitoring**: Watchdog timer for hung tasks
- **Message batching**: FlushGate merges rapid consecutive messages (800ms window)
- **Send retry**: Exponential backoff with error classification
- **File reference protection**: Prevents auto-linking of `.md`, `.go`, `.py` filenames

---

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) runtime, WeChat version >= 2026.3.20, and at least one backend CLI: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://openai.com/index/codex/), or [Gemini CLI](https://ai.google.dev/gemini-api/docs/ai-studio-quickstart).

```bash
git clone https://github.com/AliceLJY/wechat-ai-bridge.git
cd wechat-ai-bridge
bun install
bun run bootstrap --backend claude
bun run setup --backend claude
bun run check --backend claude
bun run start --backend claude
```

On first launch, a QR code appears in your terminal. Scan it with WeChat to authenticate. Token is saved to `~/.wechat-ai-bridge/token.json` for subsequent launches.

---

## WeChat Commands

All commands are plain text — just type and send:

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/new` | Start a new session |
| `/cancel` | Abort the running task |
| `/sessions` | List recent sessions |
| `/peek <id>` | Read-only preview a session |
| `/resume <id>` | Resume an owned session |
| `/model` | Pick a model (reply with number) |
| `/effort` | Set thinking depth |
| `/status` | Show backend, model, cwd, session |
| `/dir` | Switch working directory |
| `/tasks` | Show recent task history |
| `/verbose 0\|1\|2` | Change progress verbosity |
| `/doctor` | Run health check |

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

The bridge uses WeChat's official **iLink Bot API** — the same protocol behind OpenClaw's WeChat integration. All communication is standard HTTP/JSON with long-polling (`getupdates`), similar to Telegram's Bot API. Media files are encrypted with AES-128-ECB on CDN.

**This is an official Tencent API.** Zero ban risk. Backed by WeChat ClawBot Terms of Use.

---

## vs. Existing Projects

| Feature | cc-weixin | wechat-acp | This project |
|---------|-----------|------------|-------------|
| AI backends | Claude only | 6 via ACP | Claude + Codex + Gemini (native SDK) |
| Session management | None | None | `/new` `/resume` `/sessions` `/peek` |
| Tool approval | Auto-allow | Auto-allow | Interactive (1/2/3/4 choice) |
| Model switching | Hardcoded | Per-preset | `/model` with numbered selection |
| File relay (in) | Text only | Images+files | Images + files + voice transcription |
| File relay (out) | None | None | Auto-detect file paths + CDN upload |
| Rate limiting | None | None | Per-user sliding window |
| Idle monitoring | None | None | Watchdog + auto-reset |
| Message batching | None | None | FlushGate (800ms merge) |
| Code as file | None | None | >60% code → file attachment |

---

<details>
<summary><strong>Configuration</strong></summary>

`bun run bootstrap --backend claude` generates a starter `config.json`.

```json
{
  "shared": {
    "cwd": "/Users/you",
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
      "model": "claude-sonnet-4-6",
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
- `weixin/types.js` — iLink protocol constants
- `adapters/` — AI backend integrations (Claude/Codex/Gemini)
- `executor/` — Execution modes

</details>

<details>
<summary><strong>iLink Protocol Notes</strong></summary>

- **Authentication**: QR code scan → `bot_token` (persisted to `~/.wechat-ai-bridge/token.json`)
- **Message flow**: `getupdates` long-poll (35s hold) → process → `sendmessage` with `context_token`
- **Media**: AES-128-ECB encrypted CDN (`novac2c.cdn.weixin.qq.com`)
- **Limitation**: 1 WeChat account = 1 bot (1:1 binding)
- **No group chat**: iLink does not support group messaging

For protocol details, see [research.md](research.md).

</details>

---

## Ecosystem

Part of the **小试AI** open-source AI workflow:

| Project | Description |
|---------|-------------|
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | Same architecture, Telegram interface |
| [recallnest](https://github.com/AliceLJY/recallnest) | MCP memory workbench |
| [content-alchemy](https://github.com/AliceLJY/content-alchemy) | 5-stage AI writing pipeline |
| [openclaw-tunnel](https://github.com/AliceLJY/openclaw-tunnel) | Docker ↔ host CLI bridge |

## License

MIT
