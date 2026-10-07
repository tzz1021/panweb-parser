# 迅雷 ops 协议规范（hop 侧：SPA → functions → backend）

> 用途：迅雷的 **settings / restore / rename / download** 四类账号相关请求由 backend 代发（前端不碰凭据与请求头）。
> 本文是这三段之间的**线格式（wire format）规范**；实现见 `functions/api/xunlei-op.js`、`backend/src/xunlei.js`，
> 前端调用面见 `src/core/transport/types.ts#XunleiOpPayload`。
> 相关：`docs/reverse-notes-xunlei.md`（链路与实测）、`docs/xunlei-dl-choices.md`（CONSUME/PLAY 参数）。

## 1. 拓扑

```
SPA ──POST /api/xunlei/op──► functions ──POST /api/xunlei/op──► backend ──► upstream (api-pan.xunlei.com)
     ▲                                                                    │
     └──────────────── 结果原样回传（ok / results / url / code / message）◄┘
```

- SPA **只发意图**（要做什么、对哪些 fid），不带 `authorization` / `x-captcha-token` / device 相关头。
- backend 用自己的 `xunlei_device_id` / `xunlei_captcha_sign`（换 token）与账号池里的 `authorization` 发上游请求。
- scan（`/drive/v1/share`、`/share/detail`）**不走这条链**：由 SPA 本地发（随机 device_id + 本地自造 captcha）。

## 2. 请求

`POST /api/xunlei/op`（functions 与 backend 同路径；两边都要求 `X-Proxy-Token`）

```jsonc
{
  "op": "settings" | "restore" | "rename" | "download",   // 必填
  "share_id": "VP-ZJzx6upK09hAYuwNRc34PA1",               // restore 必填（download/rename 用于日志/复用）
  "pass_code_token": "…",                                 // restore 必填（scan 分享根拿到的 stoken）
  "to_parent_id": "VP295GVjKXS6dqyMLmdAS0HKA1",           // settings / restore 的转存目标目录 fid
  "fids": ["FID1", "FID2"],                               // restore：批量
  "fid": "FID1",                                          // rename / download：单文件
  "name": "2026-07-06 10：58：06.zip",                     // rename：原始文件名（随机分卷后缀由 backend 追加）
  "usage": "CONSUME" | "PLAY"                             // download：取链参数（缺省/非法 → CONSUME）
}
```

- 字段无关项可省略；**不要**给未知字段（后端按白名单取用）。
- 一批多次调用是正常的：`settings`(=1 次) → 等 1s → `restore`(批量 1 次) → 逐文件 [`rename`(压缩类) → 等 1s → `download`]。
- **download 不能批量**；rename 也不能批量（都逐文件、间隔 1s）。

## 3. 响应

**HTTP 200 + 业务体**（业务失败也走 200，便于前端逐文件展示）：

```jsonc
// 成功（restore）
{ "ok": true, "results": [ { "fid": "分享内 id", "fileId": "我盘新 id" } ] }

// 成功（download）
{ "ok": true, "url": "https://…xunlei.com/download/?…", "expiresAt": 1791031414000,
  "size": 519758446, "detail": { /* 脱敏详情：device_id/share_id/task_id、links 的 expire/token_type 等 */ } }

// 失败（业务）
{ "ok": false, "code": "NO_ACCOUNT", "error": "NO_ACCOUNT", "message": "未配置迅雷托管账号：…" }
```

**链路层错误用 HTTP 状态码**（前端将其归类为「后端断线」）：

| HTTP | error | 含义 |
|---|---|---|
| 400 | `BAD_BODY` / `BAD_OP` | 请求体非 JSON / op 不在白名单 |
| 401 | — | `X-Proxy-Token` 校验失败（functions 侧） |
| 501 | `BACKEND_NOT_CONFIGURED` | functions 未配 `BACKEND_URL` |
| 502 | `BACKEND_UNREACHABLE` / `BACKEND_BAD_RESPONSE` | 后端不可达·超时 / 返回非 JSON |

业务错误码（`code`）约定：`NO_ACCOUNT`（账号池没有可用迅雷账号）、`NOT_FOUND`（文件不在本账号网盘）、
`NEED_RENAME`（压缩类需先 rename）、`NO_DOWNLOAD_URL`（详情里没有直链）、`OP_FAILED`（上游其它失败）、
`SAME_ACCOUNT`（同号场景，见 `docs/todo-xunlei-same-account-restore.md`）。上游透传的错误码与文案一并放进 `message`。

## 4. 前端行为约定

- 无后端 / 后端断线（501/502/405 等）→ **专属弹窗**「后端断线了。。。」，提示手动转存后自行选择 CONSUME/PLAY 取链；
  不再退化成「单文件解析失败」这类无效 toast。
- 同号（分享者=自己）：先直接 `download` 探测，成功即跳过 settings/restore（**多一次探测请求是接受的代价**）。
- 进度：逐文件回调 `done/total`（批内），UI 侧换算整体；`stage` 只作展示，不推进计数。
- 凭据永不出前端：任何情况下 SPA 都不会拿到 `authorization` / `captcha_token` / device_id / sign。

## 5. 待办

- 后端 alipan / xunlei 的**凭据填写与刷新策略**（面板录入 + 滚动更新 + 健康检查）尚未接；
  当前迅雷依赖设置项（`xunlei_authorization` / `xunlei_to_parent_id` / `xunlei_captcha_sign` 等）与账号池 `pan='xunlei'` 记录。
