<div align="center">

# wechat-ai-bridge

**在微信私聊里使用 Claude Code 和 Codex**

*从微信调用本机 Claude Code 或 Codex Agent，支持 Claude 工具审批和文件回传；另提供实验性的 Gemini Code Assist 文本后端。*

自托管的微信 AI Bridge，使用微信 iLink bot 端点。iLink 可用时，微信传输本身不需要另建隧道；各 AI 后端仍需满足自身网络连通和账号资格要求。

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](https://github.com/AliceLJY/wechat-ai-bridge/releases)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![WeChat](https://img.shields.io/badge/Interface-WeChat-07C160?logo=wechat)](https://weixin.qq.com/)

[English](README.md) | **简体中文**

</div>

> **和 cc-weixin / wechat-acp 有什么区别？**
>
> 本项目重点提供**会话管理**（`/new` `/resume` `/sessions`）、**后端选择**（Claude + Codex，以及实验性的 Gemini 文本兼容）、**Claude 工具审批**和**双向文件回传**——与 [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) 属于同一类工作流，传输入口改为微信。

---

## 能做什么

### 从微信调用本机编程 Agent

在微信里发消息，由 Bridge 主机上的 Claude Code 或 Codex 执行一轮任务。实际可用工具和文件访问范围取决于所选 SDK/CLI 及其本机配置；工作流还要求微信/iLink 与对应模型提供商均可连接。

### 会话管理

```
你: /new              ← 新建会话
你: /sessions         ← 查看历史会话
你: /resume 3         ← 恢复之前的进度
你: /backend codex    ← 切后端
你: /model            ← 切模型（回复数字选择）
```

Bridge 的会话映射和偏好保存在 SQLite。Claude、Codex 可从各自的本地 session 目录发现并恢复会话；实验性 Gemini 适配器的对话历史只在内存中，Bridge 重启后不会保留。`/sessions` 列出当前后端能够发现的会话，可用 `/resume 3` 按序号恢复。

### 多后端支持

| 后端 | 接入方式与能力 | 状态 |
|------|----------------|------|
| `claude` | Agent SDK + 本机 Claude 可执行文件；Agent 工具、可恢复会话、Bridge 工具审批 | 主推荐 |
| `codex` | Codex SDK/CLI；Agent 工具和可恢复 thread，不提供 Bridge 审批提示 | 主推荐 |
| `gemini` | Google Code Assist API 文本生成，历史只在内存中；不执行本机工具 | 实验兼容 |

通常通过启动参数 `--backend` 选择后端。只有高级部署显式加载了多个适配器时，`/backend` 才能在这些已加载后端之间切换。

### Claude 工具审批

Claude 后端请求执行工具时：

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

回复 `1` `2` `3` 或 `4`，不需要按钮，纯文字就行。

### 双向文件传输

- **发图片/文件给 Claude 或 Codex**：微信媒体自动下载、AES 解密，以经过净化的跨平台文件名存入本机 `files/`，再把本地路径交给 Agent
- **从 Claude 或 Codex 收文件**：只回传 realpath 位于当前 chat 工作目录内的普通文件；读取前拒绝 dotfile、配置/token/日志路径、符号链接逃逸、超大文件和入站 `files/` 文件
- **长输出**：超过 2000 字符的消息自动分段发送，代码块保持完整

实验性 Gemini 文本后端没有本机工具，不能自行读取已下载的本地文件。

### 数据与信任边界

- **默认保存在本机**：Bridge 配置、token、SQLite 会话/任务映射，以及入站媒体解密后的副本。
- **发起者默认拒绝**：只有 `shared.allowedUserIds` 中精确匹配 iLink `from_user_id` 的用户会被处理。未知发起者会在媒体下载、审批、命令和模型调用之前被拒绝。
- **微信传输链**：消息和 context token 会经过 iLink 端点；媒体会从微信 CDN 下载或上传到微信 CDN。
- **模型提供商链**：prompt 以及 Agent 选取的上下文，会按所配置 Claude、OpenAI 或 Google 后端的数据处理方式发送，不会始终只留在 Bridge 主机上。
- **主机权限**：本项目不是沙箱。Claude Code 和 Codex 继承本机 CLI/SDK 获得的文件系统与进程权限；Bridge 内的工具审批目前只适用于 Claude。

### 内置可靠性

- **限流**：每用户滑动窗口
- **超时检测**：看门狗计时器
- **消息合并**：FlushGate 800ms 窗口合并连续消息
- **发送重试**：指数退避 + 错误分类
- **文件引用保护**：防止 `.md` `.go` `.py` 被自动识别为域名

---

## 快速开始

**前置条件：** [Bun](https://bun.sh) 运行时、微信版本 >= 2026.3.20、至少一个后端 CLI。

```bash
git clone https://github.com/AliceLJY/wechat-ai-bridge.git
cd wechat-ai-bridge
npm install              # 或者: bun install
bun run bootstrap --backend claude
# 编辑 config.json，把核验过的 iLink from_user_id 填入 shared.allowedUserIds。
bun run check --backend claude
bun run start --backend claude
```

首次启动时终端显示二维码，用微信扫码认证。Token 保存在 `~/.wechat-ai-bridge/token.json`，后续启动自动使用。

`shared.allowedUserIds` 是必填项，初始为空，例如 `"allowedUserIds": ["replace-with-verified-from_user_id"]`。这里只能填写经过独立核验的 iLink `from_user_id`，不能填显示名、微信昵称，也不能猜值。Bridge 不会自动认领第一个联系人；列表为空时配置校验会明确失败。被拒绝的 sender ID 只写入本机进程日志，不会自动加入白名单。`start.js` 会把配置序列化到内部环境变量 `WECHAT_ALLOWED_USER_IDS`，再加载 Bridge。

在 POSIX 主机上，Bridge 会把 `config.json`、`~/.wechat-ai-bridge/token.json` 权限设为 `0600`，把 `~/.wechat-ai-bridge/` 目录权限设为 `0700`，并拒绝这些私有路径使用符号链接。Windows 部署还应通过本机 ACL 限制这些路径。

---

## 微信命令

所有命令都是纯文本——直接打字发送：

| 命令 | 说明 |
|------|------|
| `/help` | 查看所有命令 |
| `/new` | 新建会话 |
| `/cancel` | 中断正在执行的任务 |
| `/sessions` | 查看最近会话 |
| `/resume <序号\|id>` | 按序号或 ID 恢复会话 |
| `/backend [name]` | 切换后端（claude/codex/gemini） |
| `/model [name]` | 选模型（回复数字） |
| `/effort [level]` | 设置思考深度 |
| `/status` | 查看后端、模型、目录、会话 |
| `/dir [path|-]` | 切换工作目录；`-` 返回上一个目录 |
| `/verbose 0\|1\|2` | 调整进度详细度 |

---

## 工作原理

```
微信 App ←→ iLink 服务器 (ilinkai.weixin.qq.com) ←→ wechat-ai-bridge ←→ AI 后端
                                                      │
                                                      ├── weixin/     (iLink 连接层)
                                                      ├── adapters/   (Claude/Codex/Gemini)
                                                      ├── sessions.js (SQLite 持久化)
                                                      └── bridge.js   (核心消息循环)
```

Bridge 使用微信 **iLink bot 端点**。通信采用 HTTP/JSON + 长轮询（`getupdates`），类似 Telegram Bot API；媒体上传前按该协议使用 AES-128-ECB 加密。

源码能够说明项目调用了哪些端点，但不能保证平台身份、账号资格、持续可用性或“零封号风险”。部署前请核对当时适用于账号和使用场景的微信条款。

---

## 与现有项目对比

| 功能 | cc-weixin | wechat-acp | 本项目 |
|------|-----------|------------|--------|
| AI 后端 | 仅 Claude | 6 种 (ACP) | Claude + Codex Agent；实验性 Gemini 文本后端 |
| 会话管理 | 无 | 无 | `/new` `/resume` `/sessions` `/backend` |
| 工具审批 | 全部自动放行 | 全部自动放行 | Claude 可交互审批；Codex/Gemini 无 Bridge 审批提示 |
| 模型切换 | 写死 | 按 preset | `/model` 数字选择 |
| 文件传入 | 仅文字 | 图片+文件 | 为有本机工具的 Claude/Codex 提供本地路径 |
| 文件传出 | 无 | 无 | 自动检测本地路径 + 加密上传微信 CDN |
| 限流 | 无 | 无 | 每用户滑动窗口 |
| 超时检测 | 无 | 无 | 看门狗 + 自动重置 |
| 消息合并 | 无 | 无 | FlushGate（800ms 合并） |
| 跨平台会话 | 无 | 无 | 发现本机 Claude/Codex 会话（CLI + 其他 bridge） |

对比项基于 2026-07-17 审阅时看到的项目说明，上游后续可能变化。

---

## 添加自定义后端

适配器接口设计上易于扩展。要接入新的 AI 后端（如 [OpenCode](https://opencode.ai/)、[Crush](https://github.com/charmbracelet/crush) 或任何 CLI agent）：

1. 新建 `adapters/yourbackend.js`，导出 `createAdapter(config)`：

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

2. 在 `adapters/interface.js` 注册，在 `config.js` 的 `AVAILABLE_BACKENDS` 里加上名字。

事件类型：`session_init` | `progress`（工具调用指示） | `text`（流式分块） | `result`（最终结果）。

> **社区呼声**：已收到 OpenCode / Crush 支持请求。OpenCode 提供 [JS/TS SDK](https://opencode.ai/docs/sdk/)（`@opencode-ai/sdk`）；Crush 提供 [Unix socket REST API](https://github.com/charmbracelet/crush) + SSE 流式推送。欢迎 PR！

---

## 生态

**小试AI** 开源 AI 工作流的一部分：

| 项目 | 说明 |
|------|------|
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | 同架构，Telegram 界面 |
| [tg-bridge-channel](https://github.com/AliceLJY/tg-bridge-channel) | 姊妹桥接，基于 Claude Agent View 后台 session（channel/pool 引擎） |
| [recallnest](https://github.com/AliceLJY/recallnest) | MCP 记忆工作台 |
| [openclaw-tunnel](https://github.com/AliceLJY/openclaw-tunnel) | Docker ↔ 宿主机 CLI 桥接 |

## 许可证

MIT
