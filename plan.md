# wechat-ai-bridge 实施计划

## 定位

自托管微信 AI Bridge，通过 iLink 官方 API 连接微信私聊，桥接到 Claude/Codex/Gemini 三个 AI 后端。从 telegram-ai-bridge v3.0 核心衍生，替换 IM 连接层。

## 架构

```
微信用户 ←→ iLink 服务器 ←→ wechat-ai-bridge ←→ AI 后端 (Claude/Codex/Gemini)
                              │
                              ├── weixin/          ← iLink 连接层（新写）
                              ├── adapters/        ← AI 后端（直接复用）
                              ├── sessions.js      ← 会话管理（直接复用）
                              ├── executor/        ← 执行器（直接复用）
                              └── bridge.js        ← 核心循环（从 TG 版改写）
```

## 文件复用评估

### 直接复用（不改或改极少）

| 文件 | 原因 |
|------|------|
| `adapters/claude.js` | AI 后端，与 IM 层无关 |
| `adapters/codex.js` | 同上 |
| `adapters/gemini.js` | 同上 |
| `adapters/interface.js` | 同上 |
| `executor/direct.js` | 同上 |
| `executor/interface.js` | 同上 |
| `sessions.js` | SQLite session 管理，与 IM 无关 |
| `tasks.js` | 任务追踪，与 IM 无关 |
| `config.js` | 改配置项（去 TG token，加 iLink 配置），结构不变 |
| `rate-limiter.js` | 通用限流 |
| `idle-monitor.js` | 通用超时检测 |
| `flush-gate.js` | 消息合并（微信场景同样需要） |
| `send-retry.js` | HTTP 重试（改错误分类适配 iLink） |
| `file-ref-protect.js` | 文本处理，与 IM 无关 |
| `doctor.js` | 健康检查（调整检查项） |

### 需要新写

| 文件 | 功能 | 估计行数 |
|------|------|---------|
| `weixin/api.js` | iLink HTTP API 封装（headers、token、请求） | ~120 |
| `weixin/auth.js` | 二维码扫码登录 + token 持久化 | ~150 |
| `weixin/monitor.js` | getupdates 长轮询消息循环 | ~100 |
| `weixin/send.js` | sendmessage + 文本分段 + typing | ~120 |
| `weixin/media.js` | CDN 上传下载 + AES-128-ECB 加解密 | ~150 |
| `weixin/types.js` | 消息类型常量 | ~30 |

### 需要改写（从 TG 版派生）

| 文件 | 改动点 |
|------|--------|
| `bridge.js` | 去掉 grammy，用 weixin/monitor 收消息，weixin/send 发消息。命令从 bot command 改为文本匹配。Tool approval 从 inline keyboard 改为数字选择。去掉 streaming preview（微信不支持 edit）。保留核心流程：processPrompt、文件检测、session 管理、A2A。 |
| `config.js` | 去 TG bot token，加 iLink 配置（tokenPath、workspace） |
| `start.js` | 去 TG 依赖，加扫码登录流程 |
| `progress.js` | 简化：不能 editMessage，改为发一条"处理中"→完成后删除 |

## 实施阶段

### Phase 1：骨架（能登录+能收发文本）

1. 初始化项目（package.json、.gitignore、LICENSE）
2. 写 `weixin/api.js`（HTTP 封装 + headers）
3. 写 `weixin/auth.js`（扫码登录 + token 持久化到 `~/.wechat-ai-bridge/token.json`）
4. 写 `weixin/monitor.js`（getupdates 长轮询）
5. 写 `weixin/send.js`（sendmessage + 文本分段，微信消息无明确字符限制但保守按 2000 切）
6. 写 `weixin/types.js`（消息类型常量）
7. 从 TG 版复制 `adapters/`、`executor/`、`sessions.js`、`tasks.js`
8. 改写 `bridge.js`：替换 grammy 为 weixin 模块，保留 processPrompt 核心
9. 改写 `config.js` 和 `start.js`
10. **验证点**：扫码登录 → 微信发消息 → Claude 回复 → 微信收到

### Phase 2：完整功能

11. 写 `weixin/media.js`（CDN 上传下载 + AES 加解密）
12. 实现图片接收（下载+解密→注入 prompt）
13. 实现图片/文件发送（加密+上传→sendmessage）
14. Tool approval 数字选择（用户回复 1/2/3）
15. 所有 `/命令` 改为文本匹配（微信没有 bot command 概念）
16. 复用 `rate-limiter.js`、`idle-monitor.js`、`flush-gate.js`
17. 改写 `progress.js`（发"处理中"消息→完成删除）
18. 复用 `send-retry.js`（调整错误分类）
19. 复用 `file-ref-protect.js`
20. **验证点**：发图片给 AI → AI 回复 → 发文件回来 → tool approval 工作

### Phase 3：完善 + 发布

21. 写 README.md（英文）和 README_CN.md（中文）
22. 写 config.example.json
23. Docker 支持（Dockerfile + docker-compose.example.yml）
24. `bun run bootstrap` / `bun run setup` / `bun run check` 命令
25. **验证点**：全流程冒烟测试
26. GitHub 创建仓库，初始 commit + push

## 微信 vs Telegram 体验差异处理

| 差异 | 处理方式 |
|------|---------|
| 无 inline keyboard | Tool approval + quick reply 用数字选择：回复 `1` `2` `3` |
| 无 editMessage | 不做 streaming preview，发"处理中"→完成删除 |
| 无 bot command | `/new` `/sessions` 等改为普通文本匹配 |
| context_token 必须带回 | 每条收消息保存 context_token，回复时原样带回 |
| 媒体 AES 加密 | 收发媒体都要走加解密管线 |
| 无 typing 心跳概念 | 用 sendtyping API 代替 TG 的 sendChatAction |

## 不做的

- 群聊支持（iLink 不支持建群，OpenClaw 微信版也没有群聊能力，这是平台限制）
- A2A 多 agent（私聊场景不需要跨 bot 协作）
- shared-context（同上）
- Cron 定时任务（私聊场景优先级低）

## 风险

1. **iLink API 变更**：腾讯可能调整 API，但作为官方产品，不太会突然关停
2. **速率限制未公开**：需要实际测试，保守做限流
3. **token 过期**：需要处理 session 过期（errcode -14），重新扫码
4. **AES 加密兼容**：Node.js crypto 内置 AES-128-ECB，应该没问题

## 预计工作量

- Phase 1（骨架）：新写 ~700 行 + 改写 ~500 行
- Phase 2（完整）：新写 ~300 行 + 改写 ~200 行  
- Phase 3（发布）：文档 + 配置

核心代码量约 1200 行新写 + 大量直接复用。
