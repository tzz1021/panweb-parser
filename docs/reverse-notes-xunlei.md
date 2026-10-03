# 迅雷云盘逆向笔记 v1（scan 已通 / restore+download 待登录态实测）


## 【速览】迅雷云盘（xunlei）使用说明

- **目录扫描（scan）免登录**：分享根与目录列表由前端直接请求（感谢[alist](https://github.com/AlistGo/alist)提供标识算法 + 客户端身份换验证码令牌的额方案），不需要登录账号，也不会把任何后端设备的验证码/标识暴露给前端。
- **取直链须走账号段**：在**登录态**下「转存 → 取文件详情」拿到，而验证码与设备标识绑定，所以这段请求由 **backend 完成**，前端只发意图、**不接触实际请求**。
- **压缩包会自动改名**：`zip / 7z / rar` 在迅雷侧不直接给直链，项目会先把它 rename 成 `xxx.001`伪装分卷名再取直链（作用在你自己盘里的副本上）。
- **同号分享不用转存**：若分享者就是你自己，迅雷不允许转存到自己名下 —— 但此时 file id 与你盘里的 id 相同，**跳过转存直接取直链**。
- **不需要客户端**：迅雷 web 端很开放，浏览器登录即可直接下载文件。因此cookieinput不做了

> 状态：**scan（游客）链路已真机跑通**；**restore + download 需要登录态 Bearer**，接口形态已抓、待用真实 token 实测（见 §7）。
> 证据来源： 2026-10-02 抓包 + 本地只读实测（`node xunlei-probe.mjs`，见 §9）。除注明外，所有请求都实测过状态码与响应。

## 0. 结论摘要

| 事项 | 结论 |
|---|---|
| 分享 scan 是否需要登录 | **不需要**，但每类请求都要有效的 `x-captcha-token` |
| captcha_token 能否本地自造 | **能**：`captcha_sign` = 多轮 md5 链（见 §2），实测 200 拿 token |
| 身份分家 | **scan** 用 alist 在野身份（本地自造 token）；**restore/download** 必须**登录态 web Bearer**（alist 不行），其 captcha_token **由后端注入**（web 身份的 sign 前端算不出） |
| `captcha_sign` 时效 | **无时效校验**：7 天前的 timestamp+sign 依旧 200（token 本身 300s）→ 后端可存一份手动录入的 sign 长期复用 |
| `pass_code_token` 能否绕过转存拿直链 | **不能**：`/drive/v1/files/{id}` 不带 Authorization → 401 `unauthenticated` |
| 直链需要什么头 | **什么都不需要**（裸 Range 也 206；错 Referer 也 206）→ `XL_DOWNLOAD_HEADERS` 为空；alist 那个 Dalvik UA 没必要 |
| 直链带文件名吗 | **不带**（无 `content-disposition`）→ 导出必须用我们自己的路径名；`accept-ranges: bytes`，12 路并发 Range 全 206 |
| 分页 | 游标制（`page_token` → `next_page_token`）；单页条数**由设置决定**（默认 30，超页重跑用 bulk 阈值） |
| hash | `hash` 是内部值（与直链 `g=` 参数相同）**啥也不是**；分享态那个 40 位值也不采用（ 拍板丢弃） |
| 转存 | `POST /drive/v1/settings`（设 restore_path）→ **等 1s** → `POST /drive/v1/share/restore` 两步（**可批量**），返回 `trace_file_ids` 映射 |
| **同号（分享者=自己）** | **不需要转存也不需要换号**：分享 detail 里的 file id 与分享者自己盘里的 id **完全相同** ⇒ 直接 `GET /drive/v1/files/{分享内 id}` 取直链（见 `docs/todo-xunlei-same-account-restore.md`） |
| **压缩类特殊文件** | `zip / 7z / rar`（mime `application/zip` / `x-7z-compressed` / `x-rar-compressed`）在详情里**没有** `web_content_link`/`links` ⇒ 必须先 **rename**（`PATCH /drive/v1/files/{id}` body `{name:"<原名>.<三位补零随机数>",space:""}`）才会出直链；rename **需 auth、不能批量** |
| 节奏 | settings → 1s → 批量 restore；**rename 与 download 逐文件、间阅 1s**（download 不可批量）；进度回传前端 |
| 代理 | 转发层白名单**必须含 `xunlei.com`**（否则 captcha/分享请求在我们自己的代理就被 403 拦掉，表现为「验证码服务 HTTP 403」）；但 **scan 的 captcha 只能本地算，不许从后端取**（否则后端 device_id 暴露/被标记） |
| 深链 / jumper | `?pwd=&path=<名字链>`：`buildJumpUrl` / `parseJumpUrl` / `resolveJumpPath`（逐层下钻换 fid）已实现；**path 只编码一次** |

## 1. 分享链接结构

- 短链：`https://pan.xunlei.com/s/<share_id>?pwd=<提取码>`
- **分享内子目录深链**：`https://pan.xunlei.com/s/<share_id>?pwd=<提取码>&path=<URL 编码的路径>`
 实例：`?pwd=gb8f&path=%2F%E8%BD%AF%E4%BB%B6%E6%95%B4%E5%90%88%E5%8C%85%2F%E5%BD%95%E5%B1%8F%E7%A5%9E%E5%99%A8%20bandicam`
 ⇒ path 是**用名字拼的路径**（不是 fid）⇒ jumper 已实现：`buildJumpUrl` 用名字段拼 `pwd=&path=`（**只编码一次**，`/`→%2F、空格→%20），
 `parseJumpUrl` 解出名字链，`resolveJumpPath` 从分享根按 `fileName` **逐层下钻**换出真 fid（找不到明确报错，不回退到根；每层沿用 250ms 翻页节流、最多 50 页护栏）。
 目前未见过无提取码的分享链接。
- 提取码走 URL `pwd` 参数（本项目 `extractShare()` 已能提取 → 作为 `TokenParams.passcode`）
- 分享者身份：分享响应里的 `user_info.user_id`（迅雷**不允许**把分享转到分享者自己名下，见 §3.3）

## 2. 身份与 captcha（单章，决定能否零登录 scan）

### 2.1 常量（全部集中在 `src/adapters/xunlei/types.ts`）
```
client_id = Xp6vsxz_7IYVw2BB # 借用 alist 在野身份
client_version = 8.31.0.9726
package_name = com.xunlei.downloadprovider
UA(API) = ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 … (JAVA 0)
UA(下载) = Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)
device_id = 每客户端随机 32 位 hex，首次生成后持久化（别用真实设备 id，也别与 webapp 用过的混用）
captcha_sign = "1." + md5 链(见 2.2)
```
- **web 端的 client_id 是固定的 `Xqp0kJBXWhwaTpB6`**，但它的 `captcha_sign` 算法被高度混淆且随版本更新；
 实测 linkswift 里写死的盐表（L7430）**已失效**，脚本还能跑只是因为它从 localStorage 复用旧 `captcha_sign`。
- 本地复现验证：拿 给的两组真机样本反推（1280 种变体）**全部不中** → 那份 web 盐表与样本不是一套；
 而 alist 的身份（client_id/version/package + 其 10 盐）**一次通过**，并跑通 share/detail 全链路。
 ⇒ 结论：**salt 表必须与请求里的 client_id/client_version/package 配套**，不能混搭（实测混搭 → `invalid captcha_sign`）。

### 2.2 captcha_sign
```js
let h = client_id + client_version + package_name + device_id + timestamp(ms)
for (const salt of SALTS) h = md5(h + salt)
return '1.' + h
```
10 条盐见 `src/adapters/xunlei/types.ts#XL_CLIENT.salts`。

### 2.3 取 captcha_token
```
POST https://xluser-ssl.xunlei.com/v1/shield/captcha/init
content-type: text/plain;charset=UTF-8
{ client_id, action:"<method>:<path>", device_id,
 meta:{username:"",phone_number:"",email:"",package_name,client_version,captcha_sign,timestamp,user_id},
 captcha_token? // 有上一次的就带上（失效也不影响响应，仅统计用）
 redirect_uri:"xlaccsdk01://xunlei.com/callback?state=harbor" }
→ { captcha_token, expires_in: 300 }
```
- `action` 语义 = `method:path`：分享段用 `get:/drive/v1/share`、`get:/drive/v1/share/detail`；
 登录段用 `get:/drive/v1/about`、`get:/drive/v1/settings`、`get:/drive/v1/files` …**不要所有请求复用同一个 action**。
- 缓存（模仿 linkswift）：localStorage 存 `{action, token, deviceId, expiresAt}`，**剩余 > 60s 才复用**，否则重新 init。

### 2.4 `captcha_sign` 可长期复用（2026-10-03 实测）
同一组 `(timestamp, captcha_sign)` 拿去做 init：

| timestamp 距现在 | init 结果 |
|---|---|
| 1s / 61s / 1h / 1d / **7d** | **全部 HTTP 200 + 新 token** |

⇒ 服务端只用请求里给的 timestamp 重算校验、**不做时效检查**。这解释了两个现象：
① linkswift 硬编码盐表失效后仍能跑（从 localStorage 复用旧 sign）；
② 的设计「后端存一份手动录入的 captcha_sign，长期复用、需要时滚动更新」成立。
**分工**：scan 的 token 由 SPA 用 alist 身份自造；**restore/download 的 token 由 backend 用保存的 web 身份 sign 去 init 后注入**（sign/device_id 不下发前端）。
- 登录用户的 init 建议带真实 `user_id`（游客传 `"0"`）；`settings/restore/download` 这类带 Authorization 的请求，
 按 口径「用 2b（app 形态）拿 captcha_token」。

## 3. API 全流程

### 3.1 分享根（= token 接口，返回 pass_code_token）
```
GET https://api-pan.xunlei.com/drive/v1/share
 ?share_id=<id>&pass_code=<提取码>&limit=30&pass_code_token=&page_token=
 &scene=NORMAL&order=DEFAULT_ORDER&thumbnail_size=SIZE_MEDIUM
头：x-client-id / x-device-id / x-captcha-token（+ accept/content-type/origin/referer/UA）
→ { share_status:"OK", file_num, files[], next_page_token, pass_code_token, user_info{user_id,nickname,…}, parent, params }
```
`pass_code_token` 即本项目意义上的 **stoken**（后续 detail 必带）。

### 3.2 目录列表（游标分页）
```
GET https://api-pan.xunlei.com/drive/v1/share/detail
 ?share_id=&parent_id=<目录 id>&pass_code_token=&limit=30&keyword=&page_token=
 &scene=NORMAL&order=MODIFY_TIME_DESC_V2&thumbnail_size=SIZE_MEDIUM
→ { files[], next_page_token, parent{…, params:{file_property_count}}, share_status, update_total_count }
```
- **分页实测（大宗样本）**：limit=30 → 30 条 + `next_page_token` 非空；**limit=50 → 36 条全出、token 空**；
 用 `page_token` 接着翻可得剩余 6 条。⇒ **scan 策略：默认 30 跑一次；`next_page_token` 非空 → 改 `limit=50` 重跑**
 （>50 的一级目录才需要继续翻页；此时对象数已超 bulk 阈值 100，正好一并覆盖）。
- **一级对象数**（core 大宗快通道要的 `total`）：**只对分享根可信** = `file_num`（实测 = 根一级对象数）。
 ⚠️ 2026-10-02 真机核对：**子目录拿不到** —— detail 响应的 `parent.params` 只有 `platform/platform_icon/share_id`
 （**没有** `file_property_count`）；而 `files[i].params.file_property_count` 的语义未证实
 （样本里一个文件夹报 5、它的一级对象实际只有 2）→ **不能**当一级对象数用。适配器因此对子目录不提供 `total`，
 让 core 走慢通道（收齐一级后自行计数）。
- 迅雷是**游标制**：core 的 `ListParams.marker` ↔ `page_token`，`nextMarker` ↔ `next_page_token`。

### 3.3 转存（两步，需登录态）
```
① POST https://api-pan.xunlei.com/drive/v1/settings
 { "item": "restore_path", "value": "<转存目标目录 file_id>" } → 响应 {}
② POST https://api-pan.xunlei.com/drive/v1/share/restore
 { "parent_id": "<转存目标目录 file_id>", "share_id": <分享id>, "pass_code_token": <stoken>,
 "ancestor_ids": [], "file_ids": ["<分享内 file id>", …], "specify_parent_id": true }
 → { share_status:"OK", file_id, restore_status:"RESTORE_COMPLETE", restore_task_id,
 params:{ trace_file_ids: "{\"<分享file id>\":\"<我盘file id>\", …}" } }
```
- 可批量（`file_ids` 数组，`trace_file_ids` 里一一对应）；**一次 settings 后等 1s 再批量 restore**（定稿节奏）
- **迅雷不允许接收者是分享者**：用分享响应 `user_info.user_id` 与登录态 `user_id` 比对即可提前拦（对应 UAC 表 restore 策略）；
 但**同号时根本不用转存** —— 分享 detail 的 file id 就是分享者盘里的 id（实测，两个样本均一致），
 直接 `GET /drive/v1/files/{分享内 id}` 即可，详见 `docs/todo-xunlei-same-account-restore.md`
- 转存路径即使与上次相同，也**每次都要先 settings**（ 实测）

### 3.4 取直链（需登录态；2026-10-03 真实响应 + Range 探针核准）
```
GET https://api-pan.xunlei.com/drive/v1/files/<我盘 file id>?space=&usage=CONSUME
头：Authorization: <token_type> <access_token>、x-captcha-token（由后端注入）、x-client-id、x-device-id
→ 文件对象；直链优先级：links[<mime>].url → web_content_link → medias[].link.url
```
- `links[<mime>] = { url, token(JWT), expire(ISO), token_type }`；`token_type: TOKEN_TYPE_ACCELERATION`（加速令牌，免费号无用，**忽略**）
- **直链实测（Range 探针）**：
 - 无任何请求头 → **206**；错 Referer → 206；迅雷 app UA → 206 ⇒ **CDN 不校验防盗链/UA** → `XL_DOWNLOAD_HEADERS` 应为空
 - **无 `content-disposition`** ⇒ 直链不带文件名，导出必须靠我们自己的路径名
 - `accept-ranges: bytes`；12 路并发 Range 全 206（服务端未拦；「8 线程」应是客户端侧策略）
 - URL 参数含 `e=<Unix 秒>`（= `links[].expire`，约 6h）、`vip=FREE`、`ui=<userid>`、`fileid`、`clientid`、`share_user_id`
 - 响应 `params.device_id` 与服务端请求头的 `x-device-id` **不是一回事**
- **不带 Authorization 的三种形态实测全 401 `unauthenticated`** → **pass_code_token 不能绕过转存**。

### 3.5 压缩类特殊文件必须先 rename（实测）
`zip / 7z / rar` 的文件（`file_category: ARCHIVE`，mime `application/zip` / `application/x-7z-compressed` /
`application/x-rar-compressed`）在文件详情里 **`web_content_link` 与 `links` 都是空的**（云解压是卖点）——
**rename 一次之后就有直链了**：
```
PATCH https://api-pan.xunlei.com/drive/v1/files/{id} # 需 Authorization + x-captcha-token；**不能批量**
body {"name": "<原名>.<三位补零随机数>", "space": ""} # 不要固定 001，用随机 3 位补零伪装分卷
→ 响应 file_extension 变成 .001 之类，重新 GET 详情即得 web_content_link/links
```
- 定位：**rename 是 download 的附属操作**（就像 settings 是 restore 的附属）；**逐文件**进行，rename 与 download 间 **1s**
- 其他类型（办公/代码/视频/图片/安装包）直接有直链，**不要 rename**（改名会动用户盘里的文件名）

### 3.6 流程节奏（定稿）
- 首次/非同号：`settings{restore_path}` → **1s** → `share/restore`（**批量**）→ 逐文件 [`rename`（仅压缩类）→ **1s** → `download`]
- 同号：跳过 settings/restore，直接逐文件 [`rename`（仅压缩类）→ **1s** → `download`]
- **download 不能批量**；逐文件结果与进度回传 ResultPage（批量时动态显示）

### 3.7 架构分工：scan 在前端，账号段在后端（ 拍板）
| 阶段 | 谁发请求 | 凭据/标识 |
|---|---|---|
| scan（share / share.detail） | **SPA 直接发**（经代理或直连） | 随机 `device_id`（一浏览器一个、存 localStorage，防按 IP 限制）+ **alist 在野身份** 自造 `captcha_token`；**绝不从后端取 captcha** |
| settings / restore / rename / download | **backend 发**（前端只发“意图” → functions → backend） | 后端自己的真实 `device_id` / `captcha_sign` / 账号 `authorization`；**不向前端暴漏任何请求头** |

- 理由：captcha 与 device_id 绑定；让「前端发起的请求」反复使用后端 device/captcha，容易把**后端设备甚至账号标记**。
- 因此：**前台关闭个人账号注入渠道**（cookieInput 只留提示文案），个人账号只走账号池/后端维护。
- access_token 来源：`POST https://xluser-ssl.xunlei.com/v1/auth/token`（`grant_type=refresh_token` + client_id/client_secret）
 或密码登录；有效期 1d；**alist 侧会与手机 app 互踢**（同一账号多端登录互相顶下线）。
- 下载要带客户端 UA（§2.1 的 `UA(下载)`）。

## 4. 字段对照（真机 → `ShareFile`）

| 真机字段 | 本项目 | 备注 |
|---|---|---|
| `id` | `fid` | 分享内文件/目录 id；转存后用 `trace_file_ids` 换成我盘 id |
| `kind` | `dir` | `drive#folder` → true；`drive#file` → false |
| `name` | `fileName` | |
| `size` | `size` | **字符串**，必须 `Number()` |
| `modified_time` | `modifiedAt` | ISO+08:00 → `Date.parse` |
| `mime_type` | `formatType` | |
| `hash` | **丢弃** | 40 位 **SHA1**（sha1-like，部分文件才有）； 拍板本项目不用，避免与 md5 列混淆 |
| `md5_checksum` | — | 实测为空 |
| `web_content_link` | — | **分享态为空**，转存后 `/files/{id}` 才有 |
| `params.file_property_count` | —（**不采用**） | 只出现在「父目录列出的子对象」上，语义未证实（folder 报 5 / 一级对象实际 2）；子目录 total 因此留空 |
| `user_info.user_id` | — | 分享者 id（判断"接收者=分享者"用） |

## 5. 错误码

| 码/字符串 | 场景 | 处理 |
|---|---|---|
| `captcha_invalid` | 缺/过期 captcha_token | 重新 `captcha/init` 后重试一次 |
| `invalid captcha_sign` | init 的 sign 不匹配（盐表/身份混搭） | 检查 client_id/version/package 与盐表是否配套 |
| `unauthenticated` (HTTP 401) | 未登录打登录态接口 | 提示填写登录态（SPA 临时框 / 账号池） |
| `9` | captcha 过期（登录态请求） | 以 `action=method:path` 重新 init |
| `4121/4122/10/16` | access_token 过期 | 刷新 token（或换号） |
| `review_panel` | 需要短信验证 | 报错并要求人工处理 |
| `not_found` (HTTP 404) | 端点/文件不存在 | 检查 id 与接口形态 |

## 6. 重大结论（决定架构）

1. **scan 与 restore/download 天然两段**：前者游客 + captcha（前端可独立完成），后者必须登录态（凭据只能来自用户或账号池）→ 与阿里云盘同构。
2. **captcha 身份是「客户端身份」不是「用户身份」**：同一 client_id/device_id 下，游客与任意账号共用同一 captcha 通道；
 device_id 随机即可、持久化复用（不要用真实/浏览器用过的 id）。
3. **转存是「一次转存、多次取直链」**：`trace_file_ids` 可复用 → 复用的粒度是 (share_id, 分享内 file_id)，
 在 access_token 有效期（1d）内有效；这也是减少账号占用时间、降低互踢风险的关键。
4. **账号并发必须串行**：迅雷同账号多端登录会互踢（alist 与手机 app 实测互踢），账号池不能并发复用同一账号。

## 7. 已核实结论 / 剩余待办

### 已核实（2026-10-03 实测回填）

| 问题 | 结论 |
|---|---|
| `params.file_property_count` 语义 | 对不上任何已知量（样本 folder 报 5、其一级对象只有 2）——**不能用于 bulk 判定**；适配器不采用，子目录不提供 `total` |
| 同号链路里 rename 是否被允许 | **允许**（带 auth） |
| rename 对 7z / rar 是否同效 | **有效**（与 zip 一致） |
| `web_content_link` 有效期 | **6h**（URL `e=` 与响应 `links[].expire` 一致） |
| OSS 是否校验 device_id / 要不要鉴权 | **不需要任何鉴权**（裸请求即可下，见 §3.4 Range 探针） |
| `settings` 是否真必须 | **未知**；但 web 端点「转存」时 16/16 次都先发 `settings` → 按现状保留（每次转存前发一次） |
| 转存配额/上限（`restore_count_left` 等） | 可能存在，但**不展示、不处理**（无样本） |
| 「分享内 id 直用」在不同号失败的错误码 | **不必查**：同号链路用「直接 download 探测」自动分流（失败即回落转存） |
| 分享者 `user_id` 携带形态 | **localStorage 覆盖式**（只存最近一次分享的 `shareId / passCode / shareUserId`，键风格同项目），供 jump/重扫与提示用 |
| 无 `user_id` 时如何判同号 | **解 JWT**（Authorization 的 payload 里有 user_id）；账号身份记录沿用 alipan carry 的做法（账号维度记录/复用） |
| 换号与 localStorage 复用冲突 | **前台不做个人账号**（账号段全部在 backend 执行）；前端只留 scan 的随机 `device_id` 与「最近一次分享」记录，冲突面收敛为「device_id 必须 first-wins」 |

### 剩余待办

- [ ] **carry 是否升键为 `(accountId, shareId, fid)`**：当前实现只按 TTL 复用；跨号命中会取到当前账号不存在的 id（失败但不写脏数据）。
- [ ] **restore→直链的真实登录态联调**：需要一个真实 Bearer；脚本 `workspace/xunlei-download-test.mjs`（默认 dry-run，凭据只从 env/文件读）。
- [ ] **`file_property_count` 的真实语义**（若哪天搞清，可恢复子目录的 bulk 快通道）。

## 8. 测试样本（真机）

| 用途 | 分享 | 提取码 | 结果 |
|---|---|---|---|
| 基本链路 | `VOwpMp92TZX27I_2RZrG-ibSA1` | `2gem` | 根 1 文件夹 → detail 2 条（1 目录 + 1 个 5.5GB zip） |
| 大宗分页 | `VP-ZJzx6upK09hAYuwNRc34PA1` | `gb8f` | 根 1 文件夹 → detail limit=30 得 30 条（token 非空）；limit=50 得 36 条（token 空） |

## 9. 探针脚本

- `workspace/xunlei-probe.mjs`：captcha → share(30/50/100) → detail(30/50 + 翻页) → 5 个 getLink 候选，**全只读**；
 用法 `node xunlei-probe.mjs <shareId> [passCode] [alist|web|mix]`
- `workspace/xunlei-fields.mjs`：把某个目录下文件/文件夹对象的**全部字段**与空值 dump 出来（字段对照用）

## 10. 与既有网盘的差异速查

| 维度 | 迅雷 | 对照 |
|---|---|---|
| token 接口 | 分享根接口顺带返回 `pass_code_token`（无独立 token 端点） | UC/夸克有独立 `sharepage/token` |
| 分页 | 游标 `page_token`/`next_page_token` | 阿里 `next_marker`（同类）；UC/夸克是页码制 |
| 反爬 | 每类请求要 `x-captcha-token`（可自造，300s） | UC/夸克无；阿里无 |
| 直链 | 必须先转存再 `/files/{id}` 取 `web_content_link` | 阿里同构（转存 + `get_download_url`） |
| hash | SHA1（本项目丢弃） | 夸克 md5、UC md5、阿里 sha1/crc64 |
