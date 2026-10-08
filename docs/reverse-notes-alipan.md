# 阿里云盘逆向笔记（据 `src/adapters/alipan/` 现状整理）

> 本文按仓库已实现的适配器代码回填（此前仓库缺这份笔记）。字段名/流程以代码与历史实测为准，
> 未在代码中体现的推测一律标「未实测」。相关：`docs/reverse-notes-uc.md`、`docs/reverse-notes-quark.md`、
> `docs/Cautions.md`（阿里直链「刚解析就显示过期」与 Referer 两难两个坑）。

## 1. 分享链接结构

- 短链（分享根）：`https://www.alipan.com/s/<share_id>`
- 旧域同构：`https://www.aliyundrive.com/s/<share_id>`
- **深链文件夹**（web 地址栏形态）：`.../s/<share_id>/folder/<folder_file_id>` —— folder 段是**纯 fid、不带名字**
  （与夸克 `<fid>-<name>` 形态不同；跳转重扫时根节点显示名会缺失，属已知小瑕疵）。

## 2. 认证与凭据

- 登录态是 **`Authorization: Bearer <web token>`**（不是 cookie）；配套 `drive_id` 与转存目标目录 `to_parent_file_id`。
- web token **约 2h** 过期（历史实测区间）；`docs/Cautions.md` 记录了「`expiration` 字段真名」的坑。
- **不支持用 cookie 恢复 web 会话**（只能扫码登录或走 alist 的 opensdk/refresh_token 通道；后者会与手机 app 互踢）——
  因此本项目**没有「贴 cookie 即用」这条路**，凭据只能粘贴 Bearer（+ drive_id + 目标目录）。
- **无游客通道**：扫描用的 `get_by_share`/`list_by_share` 可免登录，但 `prase`（转存 + 取直链）**硬前提是登录态**。
- 凭据串支持最省事贴法：键值对（`auth=…;drive_id=…;to_parent_file_id=…`）、裸 `Bearer xxx`、纯 JWT 都能解析；
  值里含 `;`（如 UA）不能当分隔符。

## 3. 流程

### 3.1 scan（免登录）
```
POST /v2/share_link/get_share_token     → { share_token, expiration, ... }        # 分享临时令牌
POST /adrive/v2/file/list_by_share      → { items[], next_marker }                # 目录（游标制分页）
        （取单文件元信息用 /adrive/v2/file/get_by_share）
```
- 分页是 **`next_marker` 游标制** → core 的 `ListParams.marker` ↔ `nextMarker`。

### 3.2 prase（两跳，必须登录态）
```
① 转存：POST /adrive/v4/batch  + 内层 url: '/file/copy'
   { share_id, file_id, to_parent_file_id, to_drive_id, ... }        # 可批量（本项目按批转存）
② 取直链：POST /v2/file/get_download_url
   { drive_id, file_id, expire_sec, ... } → { url, expiration, content_hash, content_hash_name, crc64_hash, size }
```
- 直链是 **OSS 预签名 URL**，且**绑定了精确 `Referer: https://www.alipan.com/`**
  （缺头 `AuthorizationArgumentError`／错头 `SignatureDoesNotMatch` ⇒ 必须原样注入；见 `ALIPAN_DOWNLOAD_HEADERS`）。
- 浏览器地址栏直开不了（跨站导航生成不了该 Referer）→ 只能走导出命令（curl `-e` / aria2 `--referer` / gopeed `extra.header`）。

## 4. 字段对照（易错点）

| 真机字段 | 说明 |
|---|---|
| `expiration` | **直链过期时间（真名）**；早期代码误写 `expire_time` → 永远 undefined → UI 立刻判过期（见 Cautions） |
| `content_hash` + `content_hash_name` | 校验和（sha1 等） |
| `crc64_hash` | crc64 |
| `next_marker` | 目录分页游标 |
| `drive_id` / `to_parent_file_id` | 凭据串必备字段（转存落地与取直链都要） |

## 5. 错误码

- `ERROR_MESSAGES`（取直链/通用）、`COPY_ERROR_MESSAGES`（转存内层批量错误，含 `QuotaExhausted.Drive`、
  `ForbiddenNoPermission.File` 等**点号形态**）——码来自上游 body 的 `code`，**先标点归一**再查表，同时保留原始码透传 UI。
- carry 相关：`ALIPAN_CARRY_EXPIRED_CODES = ['AccessTokenInvalid','AccessTokenExpired']`（凭据过期 → 走「续杯/换新」提示）；
  `ALIPAN_CARRY_STALE_CODES`（转存副本失效类，如存过又删）。

## 6. 本地存储与 carry（**键位规范参考**）

统一存储键：`pan-web:alipan-carry:v1`（v1.3.1 起**不再分键值对**，一条记录装全部；旧的 `pan-web:alipan-auth:v1` 会迁移并删除）
```
{
  lastUserId: string,        // 上次使用的账号身份（JWT userId；解不出时降级 drive:<drive_id>）
  lastAuth:   string,        // 上次使用的凭据串（原文，用于下次合并/回填对比）
  driveId?:   string,
  toParentFileId?: string,
  updateAt:   number,        // 最近写入时间（“上次使用的账号”判定）
  files:      { [srcFid: string]: string }   // 分享内 file_id → 转存后 file_id（滚动更新）
}
```
- `files` 容量上限 **500**（超出丢最早写入）；`updateAt` 用于判定「上次账号」。
- **换号语义**：`planCredentialSave()` 判 `verdict: 'new' | 'same' | 'changed'`；
  **`changed`（换号）→ 覆盖记录并作废旧账号的 `files` 映射**（否则会拿别的账号转存出来的 file_id 去取直链）。
  → 所以「账号维度」是靠**记录级隔离 + 换号即作废**实现的，`files` 的键**只有分享内 fid、不额外带 accountId**。
- 命中 `files[srcFid]` → **只发 download，跳过 restore**（“续杯”）；download 报副本失效类码 → 清该条映射。

## 7. 与迅雷的对照（carry 键位建议）

| 维度 | 阿里（现状） | 迅雷（当前实现） | 建议 |
|---|---|---|---|
| 存储键 | `pan-web:alipan-carry:v1`（统一记录） | `pan-web:xunlei-carry:v1`（映射表 + TTL 12h） | 对齐：统一记录 + `updateAt`，去掉纯 TTL 判定 |
| 映射键 | 分享内 `fid` | 分享内 `fid` | 保持一致（**不加 accountId**） |
| 账号维度 | 记录级 `lastUserId` + 换号作废 | 无 | 补 `lastUserId`；后端账号段还应记录 `accountId` 供换号作废 |
| 过期判定 | 上游 `AccessTokenInvalid/Expired` → 续杯/换新提示 | TTL 12h | 改成按上游错误码（同号/失效靠码识别） |
| 复用命中 | 命中即跳过 restore | 命中即跳过 settings+restore | 一致 |

## 8. 未实测 / 限制

- **cookie 恢复 web 会话不可行**（阿里侧限制）→ B 端自动化方案待研究（opensdk 与手机互踢，暂放弃）。
- 深链 folder 段不带名字 → 跳转重扫时根节点名缺失（需 `get_by_share` 补名才算完整）。
- 直链浏览器直开不可行的结论来自 §3.2 的 Referer 绑定实测，未再复核。
