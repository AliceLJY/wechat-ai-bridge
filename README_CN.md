<div align="center">

# wechat-ai-bridge

**完整 AI 编程 Agent，在微信私聊里用**

*跑真正的 Claude Code / Codex / Gemini——不是 API 套壳——有会话管理、工具审批、文件回传。*

自托管的微信 AI Bridge，通过官方 iLink Bot API 连接。不用翻墙，零封号风险。

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](https://github.com/AliceLJY/wechat-ai-bridge/releases)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![WeChat](https://img.shields.io/badge/Interface-WeChat-07C160?logo=wechat)](https://weixin.qq.com/)

[English](README.md) | **简体中文**

</div>

> **和 cc-weixin / wechat-acp 有什么区别？**
>
> 它们连接一个 AI 后端，做基础消息转发。本项目增加了**会话管理**（`/new` `/resume` `/sessions`）、**多后端切换**（Claude + Codex + Gemini）、**工具审批交互**、**双向文件回传**——跟 [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) 一样的工作流，现在搬到微信。

---

## 能做什么

### 口袋里的完整 AI Agent——不用翻墙

在微信里发消息，收到完整的 Claude Code 回复——Bash、Read、Write、Edit、Glob、Grep、WebFetch 等原生工具全部可用。不需要终端，不需要翻墙，微信能用的地方就能用。

### 会话管理

```
你: /new              ← 新建会话
你: /sessions         ← 查看历史会话
你: /resume 3         ← 恢复之前的进度
你: /peek 5           ← 只读预览
你: /model            ← 切模型（回复数字选择）
```

会话持久化在 SQLite 里，重启、断网、重开机都不丢。

### 多后端支持

| 后端 | SDK | 状态 |
|------|-----|------|
| `claude` | Claude Code（Agent SDK） | 主推荐 |
| `codex` | Codex CLI（Codex SDK） | 主推荐 |
| `gemini` | Gemini Code Assist API | 实验兼容 |

用 `/backend` 切换。

### 工具审批

AI 需要执行工具时：

```
🔧 需要授权: Bash
命令: git push origin main

回复数字选择：
1. ✅ 允许（仅本次）
2. ✅ 始终允许（本会话）
3. ❌ 拒绝
4. 🔓 YOLO（全部放行）
```

回复 `1` `2` `3` 或 `4`，不需要按钮，纯文字就行。

### 双向文件传输

- **发图片/文件给 AI**：微信媒体自动下载、AES 解密、注入 prompt
- **从 AI 收文件**：AI 生成的文件自动加密上传到 CDN，发回微信对话
- **长代码输出**：超 2000 字符且代码占比 >60% → 自动转为文件附件

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
bun install
bun run bootstrap --backend claude
bun run setup --backend claude
bun run check --backend claude
bun run start --backend claude
```

首次启动时终端显示二维码，用微信扫码认证。Token 保存在 `~/.wechat-ai-bridge/token.json`，后续启动自动使用。

---

## 微信命令

所有命令都是纯文本——直接打字发送：

| 命令 | 说明 |
|------|------|
| `/help` | 查看所有命令 |
| `/new` | 新建会话 |
| `/cancel` | 中断正在执行的任务 |
| `/sessions` | 查看最近会话 |
| `/peek <id>` | 只读预览某个会话 |
| `/resume <id>` | 恢复已有会话 |
| `/model` | 选模型（回复数字） |
| `/effort` | 设置思考深度 |
| `/status` | 查看后端、模型、目录、会话 |
| `/dir` | 切换工作目录 |
| `/tasks` | 查看任务记录 |
| `/verbose 0\|1\|2` | 调整进度详细度 |
| `/doctor` | 健康检查 |

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

Bridge 使用微信官方 **iLink Bot API**——和 OpenClaw 微信集成用的是同一套协议。全部通信走标准 HTTP/JSON + 长轮询（`getupdates`），类似 Telegram Bot API。媒体文件在 CDN 上用 AES-128-ECB 加密。

**这是腾讯官方 API。** 零封号风险，有《微信ClawBot功能使用条款》背书。

---

## 与现有项目对比

| 功能 | cc-weixin | wechat-acp | 本项目 |
|------|-----------|------------|--------|
| AI 后端 | 仅 Claude | 6 种 (ACP) | Claude + Codex + Gemini（原生 SDK） |
| 会话管理 | 无 | 无 | `/new` `/resume` `/sessions` `/peek` |
| 工具审批 | 全部自动放行 | 全部自动放行 | 交互式（1/2/3/4 选择） |
| 模型切换 | 写死 | 按 preset | `/model` 数字选择 |
| 文件传入 | 仅文字 | 图片+文件 | 图片 + 文件 + 语音转文字 |
| 文件传出 | 无 | 无 | 自动检测路径 + CDN 上传 |
| 限流 | 无 | 无 | 每用户滑动窗口 |
| 超时检测 | 无 | 无 | 看门狗 + 自动重置 |
| 消息合并 | 无 | 无 | FlushGate（800ms 合并） |
| 代码转文件 | 无 | 无 | >60% 代码 → 文件附件 |

---

## 生态

**小试AI** 开源 AI 工作流的一部分：

| 项目 | 说明 |
|------|------|
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | 同架构，Telegram 界面 |
| [recallnest](https://github.com/AliceLJY/recallnest) | MCP 记忆工作台 |
| [content-alchemy](https://github.com/AliceLJY/content-alchemy) | 5 阶段 AI 写作流水线 |
| [openclaw-tunnel](https://github.com/AliceLJY/openclaw-tunnel) | Docker ↔ 宿主机 CLI 桥接 |

## 许可证

MIT
