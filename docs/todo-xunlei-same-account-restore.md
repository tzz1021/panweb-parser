# 迅雷「分享同号无法转存」策略（定稿 v1.4 · 2026-10-03）

> 状态：**定稿**（实测后拍板；如不合理他会人工修改再通知）。
> 相关：`src/adapters/xunlei/download.ts`、`docs/reverse-notes-xunlei.md` §3.3/§11、
> 特性表 `XL_LIMITS.restoreStrategyNote: '不允许接收者是分享者'`。

## 【现象】

- 迅雷**不允许接收者就是分享者**（把分享转存进分享者自己的网盘）：用与分享者**同号**的登录态解析该分享时，
 `POST /drive/v1/share/restore` 会被上游拒绝。
- 当前适配器不做前置拦截：先发一次必然失败的写请求（settings + restore），再由服务端错误码透传给用户。

## 【定稿结论：同号时**跳过转存**，直接用分享里的 file id 取直链】

实测（两个样本，公开分享 detail ↔ 分享者账号内）：

| 样本 | 分享 detail 里的 id | 分享者账号里的 id |
|---|---|---|
| `VOwpMp92TZX27I_2RZrG-ibSA1` 内 `…zip.001` | `VOwpMSS5APdpXPsv4l8nWaW9A1` | **相同** |
| `VP2wtOIkkPO-si3lsr7_aAk_A1`（pwd `dm4f`）内 apk | `VP295YHup5AKtzMOVbZbTxPHA1` | **相同** |

⇒ 迅雷的 file id 在「分享视图」与「分享者自己的盘」里是**同一个 id**。

**因此同号链路 = 不需要 settings、不需要 restore、不需要换号**：

```
同号判定 → rename（仅压缩类，见下）→ 1s → GET /drive/v1/files/{分享内 id} → 直链
```

（首次进入 / 不同号时仍走原链路：`settings{restore_path}` → 1s → 批量 `share/restore` → 逐文件 rename/download。）

## 【判定方式】

- 分享者：scan 分享根响应 `user_info.user_id`（现有 `XlShareListResponse.user_info`，需由 scanner 上抛）。
- 接收者：后端账号池里该账号的 `user_id`（或从 Authorization JWT 解出）。
- **相等 ⇒ 同号** → 走跳过转存链路。
- 兜底：即便判定不出来，用「分享内 id 直接取详情」失败（401/404）时再回落到转存链路一次即可（幂等、无写副作用）。
 —— 具体错误码以真机为准（**待补**，见末节）。

## 【与账号池 / 复用（carry）的交互】

- 同号链路**不产生 carry 映射**（没有转存），也就不存在「同号写脏缓存」的问题。
- **carry 的键仍应升级为账号维度**：当前实现是 `(shareId, 分享 file id)`，不含账号 ⇒ 换号后若命中别的账号
 转存出来的 file id，会拿不存在的 id 去取直链（必然失败但不写脏数据）。
 建议 `(accountId, shareId, fid)`；影响面在 `download.ts` 的复用读取处（**待办，未改**）。
- 冷却：本次不再需要「同号冷却」（同号链路本来就不会打 restore）；如要抑制连点，沿用既有限频即可。

## 【待补 / 待实测（不阻塞定稿）】

- [ ] 同号链路中 **rename 是否被允许**（对象是自己盘里的文件，理论允许；实测一次即可确认）。
- [ ] 「分享内 id 直接用」在**不同号**账号上失败的确切错误码（用于兜底回落判据）。
- [ ] 分享者 `user_id` 的携带形态：进 `PanAdapter` 契约（新字段）还是适配器内部暂存（当前 TODO 项）。
- [ ] 裸 Bearer / 凭据池里没有 `user_id` 时如何判同号（解 JWT？还是要求账号必填 user_id）。
