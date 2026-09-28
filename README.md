# Codex Reset 微信提醒

只监控 **codex-resets.com**，通过 **GitHub Actions → Server酱 → 微信** 推送。

## 现在只认一个数据源

- 状态：`https://codex-resets.com/api/v1/status`
- 历史：`https://codex-resets.com/api/v1/resets?limit=30`
- 中文页面：`https://codex-resets.com/zh-CN`

不再经过 tibo.cc，也不再由脚本自己根据 Tibo 推文关键词猜测。

## 四类通知

1. 🟡 **可能/即将重置**：codex-resets.com 出现 `active_watch`，或 `scheduled_reset` 已存在但时间仍待公布。
2. 🟠 **已公布时间**：`scheduled_reset.scheduled_for` 出现具体时间，自动换算成北京时间。
3. 🟢 **已经重置**：历史接口新增 `reset_type=regular`（以及兼容的 automatic/global/hard_reset）。
4. 🔵 **Banked Reset**：历史接口新增 `reset_type=banked`（以及兼容的 banked_reset/credit）。

`no_reset` 等其他类型直接忽略。脚本不再读取正文关键词决定事件类型。

## 运行方式

GitHub Actions 每 5 分钟检查一次。检查本身不消耗 Server酱推送额度；只有发现新事件才发送微信。

同一次检查如果出现多条新事件，会合并成 **一条微信**，尽量节省 Server酱每日额度。

## GitHub Secret

仓库：

`Settings → Secrets and variables → Actions → New repository secret`

设置：

- Name: `SERVERCHAN_SENDKEY`
- Secret: 你的 Server酱 SendKey

不要把 SendKey 写进代码或 README。

## 手动测试

`Actions → Codex Reset WeChat Monitor → Run workflow`

- `发送一条微信测试消息 = true`：只测试微信链路。
- `发送 codex-resets.com 当前状态 = true`：首次升级后可同时发一条当前状态。

## 去重

状态保存在 GitHub Actions Cache 的 `.state/codex-reset-wechat-v3.json`。

同一个事件不会每 5 分钟重复发送；状态升级会再次通知，例如：

`🟡 时间待公布 → 🟠 已公布时间 → 🟢 已经重置`

升级到 v3 后第一次运行不会回放旧历史，避免刷屏。

## 说明

codex-resets.com 是第三方社区追踪站，不是 OpenAI 官方来源。它负责监测并结构化 Tibo 的公开 reset 信息；本项目只消费它给出的结构化状态。具体账户是否收到 regular reset 或 banked reset，最终以 Codex 的 `Profile → Usage` 页面为准。
