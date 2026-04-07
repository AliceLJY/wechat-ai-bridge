# wechat-ai-bridge 调研报告

> 调研日期：2026-04-07

## 目标

基于微信 iLink 官方 Bot API，构建一个自托管的微信 AI Bridge，从 telegram-ai-bridge 项目的核心架构衍生而来。

## iLink 协议关键事实

**官方合法**：腾讯 2026 年 3 月正式开放个人微信 Bot API，有《微信ClawBot功能使用条款》法律文件背书。封号风险为零。

### API 端点（共 5 个）

| 端点 | 方法 | 功能 |
|------|------|------|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | GET | 获取登录二维码 |
| `/ilink/bot/get_qrcode_status?qrcode=xxx` | GET | 长轮询等待扫码确认 |
| `/ilink/bot/getupdates` | POST | 长轮询收消息（hold 35s） |
| `/ilink/bot/sendmessage` | POST | 发送消息 |
| `/ilink/bot/sendtyping` | POST | 发送"正在输入"状态 |

辅助端点：
- `POST /ilink/bot/getuploadurl` — 获取 CDN 预签名上传 URL
- `POST /ilink/bot/getconfig` — 获取 typing_ticket

**Base URL**: `https://ilinkai.weixin.qq.com`
**CDN**: `https://novac2c.cdn.weixin.qq.com/c2c`

### 认证流程

1. 调用 `get_bot_qrcode` 获取二维码
2. 展示二维码，用户微信扫码
3. 长轮询 `get_qrcode_status`，状态：wait → scanned → confirmed
4. 确认后获得 `bot_token`
5. 后续所有请求用 `Authorization: Bearer {bot_token}` 鉴权

### 请求头格式

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
X-WECHAT-UIN: <base64(String(randomUint32()))>   // 每次随机，防重放
Authorization: Bearer <bot_token>
```

### 消息格式

**收消息** (getupdates 返回):
```json
{
  "from_user_id": "xxx@im.wechat",
  "to_user_id": "xxx@im.bot",
  "message_type": 1,
  "context_token": "AARzJWAF...",
  "item_list": [
    { "type": 1, "text_item": { "text": "你好" } }
  ]
}
```

**发消息** (sendmessage 请求):
```json
{
  "msg": {
    "to_user_id": "xxx@im.wechat",
    "message_type": 2,
    "message_state": 2,
    "context_token": "<必须从收到的消息中原样带回>",
    "item_list": [{ "type": 1, "text_item": { "text": "回复" } }]
  }
}
```

### 消息类型 (item_list[].type)

| type | 含义 |
|------|------|
| 1 | 文本 |
| 2 | 图片（CDN + AES-128-ECB 加密） |
| 3 | 语音（silk 编码，附带转文字） |
| 4 | 文件附件 |
| 5 | 视频 |

### 媒体文件处理

所有 CDN 媒体经 AES-128-ECB 加密：
- **上传**：生成随机 AES-128 key → 加密文件 → `getuploadurl` 获取预签名 URL → PUT 到 CDN → sendmessage 带上 aes_key
- **下载**：从 CDN 下载密文 → AES-128-ECB 解密

### 限制

- 每个微信账户只能创建 1 个 Bot（1:1 绑定）
- 无历史消息 API，只有实时消息流
- 群聊支持有限/未公开文档
- 速率限制未公开
- 需要微信版本 >= 2026.3.20

## 竞品分析

| 项目 | 定位 | AI 后端 | 代码量 | 我们的差异化 |
|------|------|---------|--------|-------------|
| cc-weixin | Claude Code + 微信 | 仅 Claude | ~200 行 | 无 session 管理、无多后端、无 tool approval |
| wechat-acp | 通用 ACP 桥接 | 6 种 (via ACP) | ~1000 行 | 无 session 管理、无 tool approval、无 A2A |
| openclaw-weixin | OpenClaw 插件 | 绑定 OpenClaw | 41 文件 | 不可解耦独立运行 |

**我们的独有优势**：
1. Session 管理（/new /resume /peek /sessions）
2. 多后端原生 SDK 调用（Claude Agent SDK / Codex SDK / Gemini）
3. Tool approval 交互（数字选择：1=允许 2=拒绝 3=始终允许）
4. 文件/图片双向传输
5. Idle monitor + 看门狗
6. 可选的 A2A 多 agent 协作

## 参考来源

- iLink 协议文档：https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md
- CodeBuddy 微信 Bot 指南：https://www.codebuddy.cn/docs/workbuddy/WeixinBot-Guide
- cc-weixin 源码：https://github.com/hao-ji-xing/cc-weixin
- wechat-acp 源码：https://github.com/formulahendry/wechat-acp
- npm 包：https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin
- Python SDK：https://www.piwheels.org/project/wechat-clawbot/
