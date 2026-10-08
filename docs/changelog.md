# 变更日志（changelog）

> 面向开发者（repo:/dev/ 入口）。面向用户的说明见 README.md。
> 约定：`## [版本] 日期` + 三块（新增 / 修复 / 变更）。

## [1.4.1] 2026-10-08 —— 后端与面板修复批次（凭据参数 / 智能写入 / CDP 绑定）+ SPA 两处修正

> 状态：**已实现待审**（未 commit / 未 push；tag 建议 `1.4.1`）。
> 背景：前台 SPA 已先推送；本批以后端/webui 为主，SPA 另修两处（proxy 凭据、粘贴即解析）。

### 新增
- **面板「添加/编辑账号」特别参数手填**：xunlei → `to_parent_id` / `user_id` / `captcha_sign` / `captcha_timestamp` / `device_id`（落 `xunlei_*` 设置，与 CDP 抓取同源）；
  alipan → `drive_id` / `to_parent_file_id`（落凭据串，与 `PAN_KEYS.alipan` 同源）。补上「CDP 只能抓 auth、抓不到转存参数」的缺口。
- **「智能写入」**：
  - **设置键**：按键级临时/长期（`setting_temps(k, prev_v, expires_at)` + `setSettingSmart/sweepTempSettings`），到期**恢复旧值**（不是清空）；手动（长期）写入清掉该键临时记录。
  - **账号凭据串的键**（与设置键同族语义）：新表 `account_key_temps(account_id, key, prev_value_enc, expires_at)`（快照值同 AES 加密）；
    `POST /api/web/accounts` 支持 `keyTemps: { "__pus": { ttlMinutes: 120 } }`（不标=长期）；到期**恢复该键旧值**、旧值不存在则删键；
    未标临时的键=**手动长期写入**（清掉该键临时记录且不回退）；账号详情只回 `keyState: hit|none` + `tempKeys`（key+到期，**不带值**）；
    账号级 `temp_expires_at` 保留共存（账号级到期连带清其按键级记录）。面板：检测到的每个键一行「长期/临时 + 分钟」，列表显示临时剩余（脱敏）。
  - 清扫：读接口懒清 + **5 分钟 ticker**（非秒级）。
- **CDP 浏览器 ↔ 账号绑定**（`backend/src/cdp-bind.js`，JSON 记录含 `port/accountId/userId/label/note/updatedAt`）：同 port 再抓**写回同一账号**（不再新建第二个号），冲突 409 + 允许 `rebind`；面板可**手动输入 port** 并查看绑定列表。
- **后端新增 `cookie-text.js`**（`parseCookieText / buildNetscape / cookieStringFrom`，与 SPA `adapters/quark/cookies.ts` 同语义）+ **CDP `getAllCookies()`**（`Network.getAllCookies`，含 HttpOnly）+ 面板侧同构解析器。

### 修复
- **面板添加账号报「未知网盘 pan：alipan（支持 quark/uc/xunlei）」** → `PAN_KEYS.alipan` 与 `addHost` 白名单补 alipan。
- **账号管理「删除」按钮失效**（输入后台令牌也删不掉）→ 根因：服务端**只在 POST/PUT 时读 body**，DELETE/PATCH 的二次确认令牌被丢弃 → 现在四种方法都解析 body，服务端真校验。
- **凭据识别名不副实**：面板/前台都只认 header string，且「已检测到…」要按 Ctrl+F → 现支持 **Netscape / JSON / header**，且**输入即实时检测**（300ms debounce）。
- **CDP 抓取探针数量不足** → 改按 **Netscape 全量**抓取（键白名单扩到 `__pus/__uid/__puus/__sdid/__kp/__kps/__ktd/_UP_A4A_11_` 等），失败回落 `document.cookie` 并记日志。
- `Plugins.jsx`：xunlei 驱动**补 5 分钟限频**（`force` 可跳过，用于改绑/排障），按钮与其它驱动统一。
- **SPA：proxy 模式下本地显式粘贴的夸克凭据不再被丢弃**（旧逻辑 `inProxyMode` 直接置空，导致「杀掉 backend、只用 wrangler 独立代理」时前台填的 cookie 不进请求）。
- **SPA：粘贴框改「粘贴即自动解析」**（Netscape / JSON / header string 贴进去直接填入并实时显示检测结果，不再需要先点导入按钮）。

### 变更
- xunlei 特别参数落 `settings`、alipan 落凭据串（两者各与其已有同源，不新开第二套）。
- 未改 CDP 抓取自身行为（仅新增 `getAllCookies` 原语）；真机 CDP 与面板交互仍待人工核。

## [1.4] 2026-10-03 —— 迅雷云盘适配器（第四个驱动）

> 状态：**已实现待审**（未 commit / 未 push）。逆向依据与全部真机证据见 `docs/reverse-notes-xunlei.md`；
> 同号分享策略见 `docs/todo-xunlei-same-account-restore.md`。
> 未验证：同号链路 rename / 7z·rar 的 rename 已按实测结论写入文档；restore→直链仍未经真实登录态联调。

### 新增
- **迅雷云盘（xunlei）适配器**：`src/adapters/xunlei/`（`types` / `selector` / `captcha` / `scanner` / `download` / `auth` / `registry`）。
  - **scan（游客可跑）**：`GET /drive/v1/share`（拿 `pass_code_token` 作 stoken）→ `GET /drive/v1/share/detail`（游标分页：`page_token` ↔ `next_page_token`）。
    一级对象数**只对分享根可信**（`file_num`）；子目录**不提供** `total`（上游不回该值，退回 core 慢通道自行计数）。
  - **captcha（每类请求都要）**：`captcha_sign = "1." + md5 链（身份三件套 + device_id + timestamp，逐盐 md5）`；
    `POST xluser-ssl.xunlei.com/v1/shield/captcha/init` 领 300s token；缓存 `{action, token, deviceId, expiresAt}`，**剩余 >60s 才复用**；
    `device_id` 随机 32hex 持久化（`pan-web:xunlei-device:v1`）。身份三件套 + 10 条盐集中在 `types.ts`
    （借 alist 在野身份；web 端盐表已失效/高度混淆，Tzz 拍板「顶多封掉 alist」）。
  - **restore + download（需登录态）**：`POST /drive/v1/settings {restore_path}` → `POST /drive/v1/share/restore`（批量，返回 `trace_file_ids` 映射）
    → `GET /drive/v1/files/{我盘新 id}?space=&usage=CONSUME`；直链优先级 **`links[<mime>].url` → `web_content_link` → `medias[].link.url`**，
    `expiresAt` 优先 `links[].expire`（ISO）回退 URL 的 `e=` 秒；`token_type: TOKEN_TYPE_ACCELERATION` 忽略（免费号无用）。
    带本地 carry-over 复用（`pan-web:xunlei-carry:v1`，TTL 12h，命中即跳过 settings+restore 直接取直链）。
  - **下载头为空**（`XL_DOWNLOAD_HEADERS = {}`）：真机 Range 探针证实**裸请求也 206**（无防盗链/UA 校验）；
    直链**不带文件名**（无 content-disposition）→ 导出必须靠我们自己的路径名。
  - **captcha 分工**：scan 由 SPA 本地自造（alist 身份）；**restore/download 的 `x-captcha-token` 由后端注入**
    （web 身份 sign 前端算不出），适配器对应 `captcha: 'injected'` 模式（不本地 init、不带该头）。
  - **登录态存放**：与 quark/alipan 一致**存 localStorage**（`pan-web:xunlei-auth:v1`）：
    `authorization`（Bearer，容错裸 token）+ `to_parent_id`（转存目标目录 fid）+ `captcha_sign`（可选，应急自备）+ `user_id`；
    **按字段合并写入**（粘贴只带 token 不会冲掉转存目录），读取兼容 sessionStorage 旧数据。
  - `hash` **不采用**（分享态那个 40 位值是内部标识，详情接口的 `hash` 与直链 `g=` 参数同值、**啥也不是**），`ShareFile.md5` 不填。
- **UAC 表补迅雷行**（`XL_LIMITS`）：转存 ✓ / 登录 ✓ / 能否提速 ✗（未实测按不误导）/ scan「单页条数按设置（默认 30）」/
  restore「不允许接收者是分享者」/ 其他续期「Alist(SDK) 反代，会与手机 app 互踢」/ 直链有效期「6h（e= / links[].expire）」/
  download_url 额外说明「无需任何请求头（实测裸 Range 206）；直链不带文件名」/ 登录凭据「auth(JWT) 1d」；
  `PanTable` 里迅雷 `available: true`，`adapters/registry.ts` 注册。
- **迅雷专属设置区**（`components/settings/XunleiSettings.tsx` + `Preferences.xunlei`）：
  「scan 单页条数」（默认 **30**，官方同值）、「单页不够时按大宗阈值重跑」（默认开；重跑条数取 `bulkThreshold`，
  **不是写死的 50**）、「解析后显示文件隐秘参数」（默认关）。
- **文件级「隐秘参数」**（新能力 `PanAdapter.fileHiddenVolumn`）：解析后可就地查看该文件的**脱敏**详情字段
  （device_id / share_id / task_id、links 的 expire / token_type 等），**不发请求、不开外链**，用于判断后端账号是不是会员号。
- **代理/后端接线**：`functions` 白名单加 `xunlei.com`；三处 `classifyOperation`（SPA/functions/backend）同表加迅雷规则；
  backend `panOfHostname` 映射 `xunlei`；新增 `backend/src/xunlei.js`（读设置里的 `xunlei_captcha_sign/_timestamp/_device_id`，
  按 action 缓存 captcha_token、**剩余 >60s 复用**）+ `POST /api/xunlei/captcha-token`（X-Proxy-Token 鉴权，**不回传 sign/device_id**）+ 
  `functions/api/xunlei-captcha.js`（薄透传，预热/排障用；未配 BACKEND_URL → 501、不可达 → 502）；
  proxy-core 转发 restore/download 时**自动注入** `x-captcha-token`（payload 里已带则不覆盖）。
- **深链识别**：`https://pan.xunlei.com/s/<id>?pwd=&path=<URL 编码路径>` 可直接识别取分享 ID，
  新增 `parseSharePath()` 解出名字段（真正 jumper 需「按名字逐层下钻取 fid」，见 docs TODO）。

### 修复
- **迅雷全程 403 / 「验证码服务 HTTP 403」的根因 = 自家代理白名单没放行迅雷域**：
  `functions` 的 `ALLOWED_HOST_SUFFIXES` 只有 uc/quark/aliyun，captcha 与分享请求在**我们代理层**就被 403 拦掉。
  已加 `xunlei.com`（覆盖 `api-pan` / `xluser-ssl` / `pan` 三个域），并在三处分类词表同步迅雷规则。
- （自测中发现并改正的错误假设）`parent.params.file_property_count` **不存在** ——「子目录一级对象数」上游并不返回，
  适配器不再尝试用它填 `ListResult.total`（同名字段只出现在「父目录列出的子对象」上，语义未证实）。

### 变更
- 代理层三处分类词表（SPA `core/transport/types.ts` / `functions/_shared/proxy-core.js` / `backend/src/proxy.js`）加迅雷规则：
  `/drive/v1/share/restore` → restore（**必须先于 scan 判定**，否则被 `/share` 前缀吃掉）、`/drive/v1/share` 与 `/share/detail` → scan、
  `/drive/v1/files/` → download。冒烟脚本同步加断言（xunlei 域放行 + 分类四项 + 注入头）。
- backend 冒烟扩到 56 项（新增 xunlei captcha 端点的鉴权/未配置/形状断言，全部走本地 mock，不打真上游）。

## [1.3.2] 2026-09-23 —— 扫描完整性 + 大宗目录过滤（bug 修复）


> 依据：Tzz 2026-09-23 对 `1.3.1.next` 三条待拍板项的批复，完整契约见 `docs/scan-bulk-plan.md`。

### 新增
- **扫描问题可见（failed / bulk 语义严格分开）**：`TreeNode` 新增 `scanError{code,message}`（目录 list 失败：
  业务码非 0 / HTTP 非 2xx / 网络失败）与 `bulkSkipped{count,threshold}`（大宗主动跳过），`ListSnapshot` 新增
  `issues: ScanIssue[]`；`buildTreeWithIssues()` 在遍历中收集。**不再用 `children===undefined && size===0`
  表达任何语义**（该约定混合了空目录/失败/大宗三种情况，是 1.3.1 静默丢数据的帮凶）。
- **大宗目录过滤**：只按**一级对象数**判定。快通道 = 一级响应自带 `total` 的网盘（uc/quark）首屏即可判定，
  **不翻页、不递归**；慢通道 = 无 `total` 的网盘（alipan/xunlei）收齐一级响应体后计数比较。超阈值目录
  `bulkSkipped` 标记并保持折叠（`children` 不建）。阈值默认 **100**，见 `Preferences.bulkThreshold`（0 = 关闭）。
- **设置项「大宗文件判定」**：设置 → 扫描深度下方（`components/settings/DefaultMode.tsx`），改动后**下次获取资源列表**生效。
- **结果页扫描提示**：`issues` 非空时顶部出提示卡（失败/大宗计数 + 业务码去重列表），逐条写明
  「已放宽本地转发限制（120 次/分/IP）」「devtools → Network → scan 响应体确认业务码」「隐私：总部后端不记录目录树，只做限频」
  「大宗目录树需求请自建转发代理，scan 完切回原后端不影响使用」，带「不再弹出」按钮（localStorage 本机记忆，
  只关该提示卡，**不影响失败/大宗目录的行内提示**）。
- **目录行行内提示 + 主操作**：失败目录显示「请求业务码 xxx，内容不完整」，大宗目录显示
  「大宗目录（N 项 > 阈值 T），未展开」，两种情况的「转到此文件夹」都升为该行主操作按钮（复用 v1.1.6 jumper）。
- **隐私**：`operation === 'scan'` 时不再落 trace 内容（D1 的 `body_preview` 置空、`file_hits` 整表跳过），
  只保留行级统计 —— 兑现结果页「总部后端不记录目录树」的承诺。

### 修复
- **扫描失败被静默记 0（1.3.1.next 的已知问题）**：单目录 list 失败不再只留下 `size=0/children=undefined`，
  改记 `scanError` 并进 `issues` + 全局日志；同一条 UC 分享实测的「4.18 GiB → 1.12 GiB」不再不可见。
- **「扫描深度」死配置接线**：`fetchListSnapshot` 以前从未把 `maxDepth` 传给 `buildTree`，现改为三处调用
  （HomePage 常规/jumper、ResultPage 刷新资源列表）都传 `prefs.scanDepth`；语义 `depth < maxDepth`、根 = 0，
  jumper 二次获取时深度从 0 重算（设置文案已写明）。
- 0B 文件夹「转到此文件夹」判据由「空文件夹」改为业务码/大宗标记，避免把真空目录误报为风控失败。

### 变更
- **代理限频 60 → 120 req/min/IP**（`functions/api/_shared/proxy-core.js`）：429 基本不是上游风控，而是本站
  转发层自己限的；按「1s 3 次 × 并发 2」标定放宽。被限频者请自建转发代理（结果页文案已说明）。
- `scripts/proxy.smoke.mjs` 限频断言同步：由「61 次 → 429」改为「前 120 次放行 + 第 121 次 429」。
- `backend/src/server.js` 只读策略文案、`docs/transport.md` 限频口径同步为 120。

## [1.3.1.next] 2026-09-18 —— 内测反馈批次（hop 下沉 / UC hash / 夜间模式 / Windows launcher）

> 状态：**已实现待审**（未 commit / 未 push；tag 由 Tzz 定，`1.3.1.next` 为占位）。
> 本轮同时记录一条**已定位未修**的已知问题（扫描静默丢数据，见文末）。

### 新增
- **hop 探测下沉到 functions（D1 落地）**：SPA 不再直连 hop，改走 `Transport.credentialProbe()`
  → `POST {代理}/api/credential-pick`（body 只有 `{ provider, account? }`，account 为非敏感身份），
  **只暴露三态** `hit | guest | none`（不再回 `accounts: string[]`，SPA 拿不到账号集合与凭据本体）。
  `functions/api/credential-pick.js` 由 functions 去问 backend `/api/credential-pick/accounts`，
  不可达 / 老 backend 404 / 非 JSON 一律安全降级为 `none`；探测独立限频 30/min/IP。
  carry 决策随之改词：`credential-hit`（静默续杯）/ `credential-guest` / `credential-none` /
  `credential-unavailable`（直连）/ `credential-unreachable` / `credential-unimplemented`。
- **夜间模式**：偏好新增 `theme: 'auto' | 'light' | 'dark'`（默认 auto）；顶栏（header 全局共享，
  所有页面都有）加三态灯泡，单击 `auto → light → dark → auto` 轮换；写 `<html data-theme>`，
  auto 时用 `prefers-color-scheme` 解析并实时跟随；`index.css` 把浅色值全部收敛为变量并补
  `[data-theme='dark']` 整组覆盖（含 `color-scheme`，原生控件跟随）。
- **勾选行自定义底色**：偏好新增 `checkColor`（默认空 = 主题默认高亮）；结果页目录树加
  🎨 调色盘按钮（8 预设 + 默认 + 清除），即时生效并持久化；**status 红/黄/绿优先于勾选底色**
  （复合选择器 `tr.file-row--checked.file-row--<status>`，悬停规则用 `:where()` 排除）。
- **Windows launcher**：新增 `backend/launcher.ps1`（PowerShell 5.1+/7+，无需管理员），
  与 `launcher.sh` 子命令/产物路径/语义等价；差异：无 tmux（debug 用独立控制台窗口）、
  无 SIGTERM（`taskkill /T /F` + 命令行归属校验防误杀）、`chmod 600` → `icacls` 收敛 ACL。
- **UC hash（md5）**：新增 `src/adapters/uc/hash.ts#normalizeUcMd5()` —— UC 的 `md5` 有两种形态
  （16 字节摘要的 base64 `"75zWrXnoh/KB14803+wkJg=="` 与直给 32 位 hex），统一归一到小写 hex；
  接进 `DownloadResult.hash`（导出注释行）与 `ShareFile.md5`（校验和列）；`UC_LIMITS.etagNote` 同步更新。

### 修复
- `scripts/proxy.smoke.mjs` 两条**过期断言**修正：旧断言要求「丢弃 cookie / authorization」，
  但该行为自 v1.1.9（夸克登录态）与 v1.2.x（alipan Bearer）起已**有意放行**（见 proxy-core 文件头）；
  改为断言「丢弃白名单外的头 + 放行 cookie/authorization」，冒烟恢复全绿。

### 变更
- 托管状态词表统一为 `hit | guest | none`：`functions/_shared/proxy-core.js`、
  `backend/src/proxy.js`、SPA `core/transport/types.ts` 三处同表（旧 `picked` 不再产生；
  词表值变更属**跨版本兼容项**，老 SPA 读 `x-panhub-credential` 只会取不到值，不影响主流程）；
  `Access-Control-Expose-Headers` 相应加 `x-panhub-credential`。
- 前端说明文案精简：CookieInputModal 的两段托管提示合并进蓝色 inline 提示块；
  SPA 内不再出现「hop / 后端取号」这类内部术语（链路细节归 functions）。

### 已知问题（已定位，**已在 1.3.2（2026-09-23）修复**）
- **扫描失败被静默记 0**：`treeWalker` 的 catch 把失败目录 `size=0 / children=undefined`，
  失败目录不递归 → 调用数与进度条同步变小 → **结果不完整却看起来完整**。
  实测（同一条 UC 分享）：直连 223 次调用 = 4.18 GiB；经 CF Functions 60/min 限频 →
  209 次调用（149×429）= 1.12 GiB。同时确认「设置里的扫描深度」目前是死配置
  （`fetchListSnapshot` 未把 `maxDepth` 传给 `buildTree`）。修法建议见 Tzz 审议记录。

## [1.3.1] 2026-09-15 —— 凭据快捷更新（前端）+ 四类规范/后端批次进行中

> 状态：**P1（前端）已实现**；P2 functions / P3 backend / P4 插件见 `docs/wip3-plan.md`（待开工）。
> 定稿依据：Tzz 2026-09-15 草案 + 对 12 项待拍板的回复（记录在 `docs/wip3-plan.md` §9）。

### 新增
- **凭据快捷更新（同账号合并写入，根治“粘贴长 auth 冲掉其他字段”）**：
  `planAlipanCredentialSave()` 离线规划 —— 解析输入（支持只粘贴 `Bearer xxx`）→ **同账号时**
  自动用上次暂存的 `drive_id` / `to_parent_file_id` 补齐 → 算出仍缺的必填项 → 判定账号是否变化。
  同账号：静默合并写入（保留既有转存映射，续杯不断）；首次：直接写入
- **账号覆盖确认弹窗**（`AccountOverwriteModal`，阿里云盘特设、强制开启，结果页注册）：
  仅当「本次账号 ≠ 上次暂存账号」出现，标题「是否覆盖当前暂存区的 userid」；
  选「是」= 覆盖暂存记录（换号则作废旧账号转存映射）；
  选「否」= **本次输入仅本次有效**（内存态，刷新即失效，不写 localStorage、不进后端统计）
- **必填项闸门（A2）**：CookieInputModal 的小字改为「缺少必填项：auth / drive_id / …」，
  底部「保存并重试」直接置灰 —— 缺失就不写入、不惊动 functions
- **统一存储记录（丢一起）**：凭据 + 上次账号 + 转存映射合并为一条记录
  `{ lastUserId, lastAuth, drive_id, to_parent_file_id, updateAt, files: { [file_id]: copied_file_id } }`，
  键 `pan-web:alipan-carry:v1`；旧键 `pan-web:alipan-auth:v1` 只读兼容（首次读取自动搬迁）

### 修复
- **转存副本被删/进回收站**（403 `ForbiddenFileInTheRecycleBin`，“存过又删了”）：
  不再当作致命错误 —— carry 直接回退**重新转存**并刷新本地记录（与登录态过期区分开）
- 内存态（选「否」）不再污染记录：转存映射只进内存，不写库

### 变更
- 账号身份解码字段名对齐真机（阿里 web token payload 为 `userId`，兼容 `user_id/sub/uid`）
- `ALIPAN_CARRY_STALE_CODES` / `ALIPAN_ACCOUNT_SWITCH_PROMPT` / `ALIPAN_MISSING_FIELDS_HINT`
  进适配器常量区；UI 仍只引用 `adapter.carryOver.*`，零硬编码文案

### 新增（P2 functions + P3 首批）
- **四类操作规范**：`scan` / `download`（取直链，取代笼统的 prase）/ `restore`（转存，取代 copy）/ `credential-pick`（取号，取代 cookie-pick）
  —— 三处词表**同表**（SPA `src/core/transport/types.ts` / 云端 `functions/api/_shared/proxy-core.js` / 后端 `backend/src/proxy.js`），自测有防漂移断言
- **functions 按四类拆分**：共享核心下沉 `functions/api/_shared/proxy-core.js`（`_` 前缀不生成路由），
  薄路由 `scan.js` / `download.js` / `restore.js` / `credential-pick.js` + **兼容别名 `proxy.js`**（老部署/老 SPA 照旧发 `/api/proxy`）；
  路由声明与目标分类不一致 → 400 `OP_MISMATCH`（带 `classified` 回报）
- **SPA 按类路由**：ProxyTransport 按目标 URL 选 `/api/<类>`；对面是旧部署（404/405）自动回退 `/api/proxy` 并记住本会话
- **托管状态新头** `x-panhub-credential: picked|guest|none`（旧 `x-panhub-backend: ok` 保留一版过渡）
- **后端 credential-pick**：`POST /api/credential-pick`（旧 `/api/proxy/cookie-pick` 保留一版）+
  `GET /api/credential-pick/accounts?provider=&account=` → `{ accounts: string[] }`
  （**只回非敏感身份**：JWT userId → `drive:<drive_id>` → 账号标签兜底；X-Proxy-Token + 30/min 限频 + `no-store`）
- **hop 按类转发**：`backend/src/proxy.js` → `${wrangler.port}/api/<类>`（旧部署 404/405 回退 `/api/proxy`），
  取号链路改调 `/api/credential-pick`（老 backend 404 时回退 cookie-pick）

### 修复
- **取号判定词表**：`pickAccountForPan` 接受 `download`（旧 `prase` 仍兼容）—— 修「换词表后取号全部失效」（冒烟拓出）

### 变更
- 统计口径归一：历史 trace 的 `prase` 读作 `download`（旧行无法再细分转存/取直链），面板列改为 scan / download / restore / credential-pick / 其他
- 后端冒烟 **26 → 31 项**（credential-pick 取号 / 身份查询只回非敏感 / 旧路径兼容 / 无账号 404）
- 云端路由冒烟（本地 wrangler）：无令牌 401 · 四类 OP_MISMATCH · 白名单 403 · 兼容别名生效 · 真实 scan 转发 200

### 新增（P3 余项 + P4）
- **面板读写分离（读不裸奔 / 写要真令牌）**：
  - 读：账号列表只回**非敏感元数据**（id/网盘/备注/状态/身份 userId/过期/临时到期/最近使用）——
    去掉 `cookieTail`/`cookieLength`/`keys` 指纹字段；备注缺省时回退**身份（userId）**而不是 `#num`
  - 读：改读**服务端快照**（5min 自动刷新 + 写后即刷 + `POST /api/web/accounts/refresh` 手动），
    面板不再有能力「按字段查库」
  - 写：`POST`/`DELETE` 账号**服务端真校验二次令牌**（`body.confirmToken`）—— 此前只有面板前端拦，服务端没查；
    编辑不再回填凭据（写新不读旧，`credentialRefillable:false`）
- **临时写入（临时凭据）**：新增 `accounts.temp_expires_at` + 面板「临时写入」勾选 + 默认 TTL 可配
  （`account_temp_ttl_minutes`，默认 30 分钟，每次写入可单独填）；到期由 5min 定时**只清凭据**，
  **审计保留**（`account.temp-write` / `account.temp-expired`）
- **P4 凭据刷新 = 手动预设**（Tzz 定稿：自动执行全部改手动，不做宏录制）：
  - `backend/src/cdp.js`：零依赖最小 CDP 客户端（内置 WebSocket；9222 = 浏览器，9229/9230 = wrangler inspector 仅 health）
  - `backend/src/presets.js`：内置预设（阿里 auth / 夸克 cookie / UC __pugs）＝固定脚本化流程
    （打开页面 → 等页面自己下发新凭据 → 读出 → 加密写账号池），**手动触发 + 每预设限频 5min + 全局单飞**
  - 面板插件页重写：浏览器 health、预设状态/上次结果/身份、运行按钮（要二次令牌）；
    **凭据与指纹不回面板**（读出来直接进加密库）
  - 插件页此前请求的 `/api/web/plugins` 后端**根本没实现**（页面永远「加载中…」）→ 现已实现

### 新增（隐私 · 响应 Tzz 审阅）
- **trace 文件明细粒度**：`trace_file_detail = full | safe | off`（设置面板可切；云端 `env.TRACE_FILE_DETAIL`）
  —— 名称+大小+哈希足以对上游**撞库反查文件**；共享/公开部署建议 `safe`（只留大小）或 `off`

### 修复
- 账号写入/删除的「二次确认令牌」此前**只有前端拦**（服务端不校验）→ 现服务端真校验（403 CONFIRM_REQUIRED）

### 待落地
- **D1**：SPA 滚动更新探测改走 functions（Tzz：后面再做；`carry.ts` 已标 TODO）
- 第三方压缩包插件（package + install.sh + webui 配置注入）：按 Tzz 定稿后续开放

---

## [1.3-carry1] 2026-09-12 —— 阿里云盘滚动更新（carry-over）

### 新增
- **auth 生命期内「续杯」免转存**：`prase` 时若缓存命中（缓存 userId === 本次 auth 的 userId 且映射命中该原 file_id）
  → 直接 `get_download_url`，**跳过 batch copy**（省空间、避免「空间满了」）；未命中 → 正常两跳并把新 file_id 写回缓存。
  缓存键 `pan-web:alipan-carry:v1`，形态 `{ userId, driveId, files: { <原分享 file_id>: <转存后 file_id> }, updatedAt }`
  （v1.3.1 起合并为统一记录 `{ lastUserId, lastAuth, drive_id, to_parent_file_id, updateAt, files }`，见下条）
- **凭据过期提示（红色 toast）**：仅「本地有缓存 + 已发出的一次请求失败（不重试）」时判定；
  用本次 auth 的 userId 探 hop（`Transport.hopAccounts`，端点 `GET {代理}/api/hop/accounts?provider=alipan&account=`，404/501 = 未实现）
  —— 命中同账号 → 静默续杯；未配置/不可达/未实现/空/不含该账号 → 弹
  「凭据过期了，建议填入上次同一个账号的新凭据这样无需转存哦」
- **新凭据离线校验（CookieInputModal 行内）**：离线解新 auth 的 userId 与缓存比对，
  一致 → 绿字「没删吧？老铁」；不一致 → 红字「换号了？再存一次哦」（不请求任何接口、不新开弹窗）
- **auth 串兼容裸形态**：只写 `Bearer xxx`（无 `auth=` 前缀、无其他字段）、`Authorization: Bearer …` 整行、纯 JWT
  都能当 auth 用；`drive_id`/`to_parent_file_id` 仍可键值对混写；弹窗键检测跟随适配器解析，不再误报「未检测到 auth」
- **话术外置**：本轮全部定制文案集中在 `adapters/alipan/types.ts#ALIPAN_CARRY_MESSAGES`，UI 只读 `adapter.carryOver.messages`

### 修复
- **缓存里的 file_id 已失效**（用户删了转存文件等）→ 自动回退正常 copy 并覆盖缓存；登录态错误不回退（与「过期不重试」一致）
- 适配器能力对象化：`PanAdapter.carryOver`（expiredCodes / onExpired / checkNewAuth / messages）——UI 不 import 具体适配器

### 变更
- 滚动更新缓存放 localStorage（**不用 footprint/IndexedDB**）：core 零网盘依赖、单条内部状态、与 alipan 凭据同层便于清理（理由见 `adapters/alipan/carry.ts` 文件头）
- `adapters/alipan/scanner.ts` 的取直链逻辑抽为 `fetchDownloadUrl()`；转存批次改为**只对未命中文件**下发（下标映射保持）

---

## [1.3-docs1] 2026-09-12 —— 文档：坑位日志 + 后端草案

### 新增
- `docs/Cautions.md`：坑位日志（18 条，时间倒序，现象/根因/修法/教训四段，只收已查实的）
- `docs/STRUCTURE.md` 文末「插件体系（草案）」「后端待办（草案）」两节（含冲突待拍板表）

---

## [1.3] 2026-09-11 —— 阿里云盘真机修复：直链 15min / expiration 字段 / 下载头落地

### 修复
- **直链「刚解析就显示过期」**：上游过期字段真名是 `expiration`（ISO），代码误写 `expire_time` → undefined →
  `ossUrlExpiryMs()` 只认 UC/夸克签名形态（`Expires=`/`auth_key=`）→ null → linkStatus「无过期信息 = 过期」兜底 → 三层连坐误判。
  修：类型补 `expiration/content_hash/content_hash_name/crc64_hash/size`（保留 `expire_time` 兼容）、
  scanner 用 `expiration ?? expire_time`、`expiresAt` 接上、`hash = content_hash`（sha1）、`size` 兜底目录树值
- 转存内层错误码 `.` 形态归一命中（真机 `QuotaExhausted.Drive`）

### 变更
- **下载层静态头回退适配器**：`ALIPAN_DOWNLOAD_HEADERS = { Referer: 'https://www.alipan.com/' }`（精确值，OSS 签名
  `x-oss-additional-headers` 绑定；其他值 403、缺失 400）；`ExportFile.headers` 由结果页按 `adapter.downloadHeaders` 组装，
  curl `-e` / aria2 `--referer` / gopeed `extra.header` 三生成器映射；curl.ts 里 UC 硬编码 UA/Referer 删除
- 真机结论固化：直链有效期 **15min**；`_headers` 全局 `Referrer-Policy: no-referrer` 与 alipan 直链**先天冲突**
  （浏览器无法产生精确 Referer）→ alipan 直链只能导出命令注入 Referer，不做浏览器直开

---

## [1.3] 2026-09-09 —— SPA+functions 适配（契约收窄 / 复用分家）

### 变更
- **linkFetcher 契约收窄（裁决权下沉适配器）**：core 不再拼 `fids/fidsTokens`、不再预判 `shareFidToken` 缺失即拒绝；
  适配器从 `files` 自行取字段，缺 per-file 令牌/不支持项在**对应下标**产出失败项（error + errorCode）
- **复用分家**：`scan` 快照复用仍看偏好 `reuseWindowHours`；`prase` 直链复用改按**上游绝对过期时间**
  （`DownloadResult.expiresAt` ← URL `Expires`/`auth_key` 或响应 `expiration`），偏好窗口退出直链判定；
  `linkStatus` 重写、`DirectoryTree` 去 prop、footprint/prase 快照补存 `cookieString/hash/expiresAt`
- `functions/api/proxy.js`：`classifyOperation`/`panOfHostname` 补 alipan 段；取号 gate 排除 alipan（登录态 = SPA 自带 Bearer）

### 新增
- `PanAdapter.downloadHeaders`（各盘在自家 types.ts 与 `*_LIMITS` 并列声明）

### 修复
- 绿：typecheck / vite build / 本地 wrangler 8788 代理 scan 链路 6/6

---

## [1.3] 2026-09-08 —— 阿里云盘接入（第三个网盘）

### 新增
- **适配器 `src/adapters/alipan/`**（types/auth/selector/jumper/scanner/registry，与 quark 同构）：
  - `scan`（免登录三连）：`/v2/share_link/get_share_token`（share_token 2h，走 `x-share-token`）+
    `/adrive/v2/file/get_by_share` + `/adrive/v2/file/list_by_share`（**next_marker 游标分页**，root 包装层自动下钻）
  - `prase`（**两跳，无游客通道**）：`/adrive/v4/batch` + `/file/copy` 转存（`x-share-token` 源授权 + `Authorization` 落盘账号，内层 201 新 file_id）
    → `/v2/file/get_download_url`（`x-canary: client=windows,app=adrive,version=v6.0.0`）
  - 直链是 OSS 预签名 URL，下载必须带**精确** `Referer: https://www.alipan.com/`
- **登录态凭据串**（非浏览器 cookie）：`auth=Bearer xxx;drive_id=…;to_parent_file_id=…;user-agent=可选;x-device-id=可选`；
  `drive_id` 必须手填（user 接口要 X-signature，不研究）；缺凭据抛 `31001` 哨兵码复用夸克弹窗流
- `CookieInputModal` 泛化：整串模式 + `load/save` 钩子 + `intro/placeholder/browserCookie:false`（不再硬编码夸克）
- `core/treeWalker` 兼容游标分页网盘（`ListParams.marker`/`ListResult.nextMarker`），uc/quark 页码制不变

### 变更
- `functions/api/proxy.js` 头白名单/域判定补 alipan（authorization / x-share-token / x-canary / x-device-id）

### 已知
- 阿里完全拒绝游客 prase（登录用户也不能直下他人分享，403 `ForbiddenNoPermission.File`）；`access_token` 有效期 ≈2h
- 幂等转存**不做**（X-signature 查不了 user 接口、copy 后 file_id 不可跟踪）→ `auto_rename` 副本累积接受，清理由用户负责

## 2026-09-03 —— 夸克凭据链路收口（fix only）

### 修复
- **夸克 <50MB 登录态直链漏绑 __puus（09-02 版修漏）**：凭据绑定从「按文件 size 分流」改为「响应驱动、
  与 size 无关」——托管/取号模式对所有 size 的 prase 一律注入正式账号 → 返回的都是 dl-pc-* 登录态直链，
  只认 __puus；此前 isBig 分支（<50MB 不读 x-quark-puus）导致上游明明回传了 __puus 也被丢弃
  （09-03 真机 41.65MB 文件复现：六种导出/推送全缺 OSS 鉴权）。scanner.ts 绑定顺序：
  __puus（本地整串 ?? 同响应回传）→ __pugs（游客响应）→ 无凭据不注入（导出软提示）
- **x-panhub-backend 头补发（09-02 该修复实际未完成）**：此前全链路没有任何服务端下发该头，
  前端守卫 getLastProxyBackendOk() 永不生效 → 取号成功仍误报「未检测到 selfhost…已按随机游客尝试」。
  现在 hop（backend/src/proxy.js）与云端取号（functions/api/proxy.js）命中**正式账号**
  （kind=real；guest 占位不发，话术才准确）才回传 x-panhub-backend: ok；cookie-pick 响应补 kind 字段；
  两端 expose 列表放行新头
- **「随机游客」预判 toast 时序修正**：弹窗取消后的预判式 toast 只在**直连**（不存在 selfhost）时弹出；
  代理模式改由请求结果说话（成功 → doFetchLinks 末尾「已使用代理托管账号」toast；失败 → 行内红 + 重试入口）。
  此前读「上一次响应」的头做预判：首次 prase 前不存在上一次响应，头再准也救不了

### 变更
- **冻结声明（不再维护，不做清理）**：书签注入/同源直连（F-书签）、CORS 兑底自动跳转（corsAutoJump）、
  qk-guestTurn（代理托管模式下本就不生效，直连场景保留）——行为以现状为准，不再投入修复

## 2026-09-02 —— 夸克取号/导出凭据小修

### 修复
- **CookieInputModal 空保存仍误报「随机游客」**：取号/托管生效（x-panhub-backend: ok）时不再 toast
  「未检测到 selfhost 也未手动填写 cookie：已按随机游客尝试」——该话术只在无 selfhost 兜底时准确；
  托管模式交给 doFetchLinks 末尾的「已使用代理托管账号」提示（backendOkToastShown 去重）
- **夸克大文件导出/推送六种方式全缺 __puus（OSS 鉴权）**：
  - 根因：代理托管路径前端登录整串不参与（loginCookie=''）→ 大文件凭据来源断链，
    即使服务端刷新会话、回传了 x-quark-puus 也没人接
  - quark scanner：捕获 x-quark-puus（与 lastResponsePugs 同生命周期：每次调用重置、按响应绑定），
    大文件 __puus 取 `本地整串 ?? 响应回传`
  - backend hop（src/proxy.js）+ CF proxy.js：取号注入后若上游未刷新 __puus，兜底回传本次实际
    下发的 __puus（x-quark-puus）——账号池会话仍有效（3h 内）时前端也能拿到导出凭据
- **curl 导出缺凭据注释话术精准化**：不再硬编码 UC __pugs —— ExportFile 新增 credLabel，
  按适配器/文件大小标注（夸克大文件 `quark __puus`、小文件 `quark __pugs`、UC 保持 `UC __pugs`）
  
## [v1.2.next2]2026-09-01——完美适配quark，多次功能更新和后端设计重构<已强制推送覆盖不安全的版本>
 
### 人工书写，不再举例

后端设计很乱，定稿查看docs/backend-wrangler-plan.md。不再展示试错过程
如果不足以满足B端需求还可以继续改进，期待你的指点


## [v1.1.9.final] 2026-08-26 —— 夸克风控：UA 定制 + 智能分流（Tzz 真机 + wrangler devtools 验证）
### 新增
- **quark download 定制 UA（QUARK_DL_UA，与 linkswift 同款）**：
  - 背景：cookie 穿透修复后错误从 400（无 cookie）变 401（有 cookie 但 UA 非客户端）——
    夸克风控校验 Electron 客户端 UA，非定制 UA + 有效登录 cookie → 401 unsafe-url
  - 实现：scanner getDownloadLinks 请求头加 `User-Agent: quark-cloud-drive/3.20.0 ... Electron/24.1.3.8`；
    浏览器禁改 UA，该头经代理 JSON body 透传、proxy.js 白名单放行后在服务端注入
  - 范围：仅 download 用（token/detail 游客态无需，与 linkswift 一致）
- **qk-guestTurn 游客模拟开关（<50MB bug 修复，Tzz 定方案）**：
  - 背景：用户填过登录态整串后，小文件请求也带上完整登录 cookie → 夸克返回登录态 CDN 直链
    但导出只配 __pugs → 凭据不匹配、文件流掐断（curl/aria2/gopeed 全部无 cookie）
  - 开关（设置 → 夸克网盘特设，默认关）：开 = 小文件走游客态（请求不注入登录态整串，
    改用捕获/随机 __pugs；无则裸请求等响应下发）→ 游客 CDN 直链 + __pugs 匹配；
    关 = 所有文件一律按登录态处理（直接弹 CookieInputModal，最稳妥）
  - 实现：DownloadParams/LinkFetchContext 加 guestMode 透传 → quark scanner 游客分支；
    分流前置条件：guestTurn 开才做 size 判断，关 = 恒按大文件
  - 副标题：配置本地管理面板后不生效（后端账号池将接管游客流转）
- **aria2/gopeed 导出额外参数真正接入（修复假把戏）**：
  - 此前 advanced.aria2Extra/gopeedExtra 只有 UI 无消费方，任何网盘都不生效
  - aria2Extra：原样拼进每条命令 --out 之后、URL 之前；gopeedExtra：JSON 对象合并进每个任务 opts
    （如 {"connections":16}，非 JSON 忽略；UI 说明同步改为 opts）
- **导出凭据按文件大小分流（Tzz 真机 200 后确认）**：
  - 大文件（≥50MB，登录态）：oss 校验令牌**只有 __puus** —— 从整串提取单个值回传，
    绝不返回完整登录 cookie（导出文件可能被分享/上传，整串泄露即账号被盗；__pus 长期凭证更不可出）
  - 小文件（游客态）：与 UC 同机制绑定同响应 __pugs
  - types：LinkResult/LinkEntry/ExportFile 新增 hash 字段，链路透传（scanner → linkFetcher → ResultPage → 导出）
- **hash 导出注释（v1.1.9.final）**：字段名**通用化 .hash**（Tzz 建议：网盘给的校验值不一定是 md5，
  模仿 linkswift config.$xxx 按网盘携带；夸克 dl 响应即 md5，适配器层 item.md5 → hash 映射）——
  aria2/curl 生成器在直链命令下一行附 `# hash: <值>`，下载后自行校验完整性（gopeed 是 JSON 格式
  无注释概念，不附；推送下载器 API 无校验位）
- **智能分流（fix1，Tzz 要求）**：adapter.cookieInput.sizeThreshold（夸克 50MB，实测 41MB 可/51MB 23018）
  —— 勾选文件含 ≥50MB 时 prase 直接弹 CookieInputModal，跳过 CookieWarnModal（游客态 __pugs 对
  23018 无意义），避免一次必然失败的 400 请求污染代理日志看板；取消时未请求过的文件标「手动终止」红
### 修复
- **fix2（cookie 头丢失）**：proxy.js forwardHeaders 键名大小写归一后再匹配白名单 —— SPA 发
  'Content-Type'/'Cookie'（大写），JS 对象键区分大小写，直接 headers['cookie'] 拿不到 → 登录态
  cookie 被静默丢弃（表现：modal 的中间变量没发到 transport）；backend/src/proxy.js 同步归一化
  请求头键（避免 Cookie/cookie 重复头）
- proxy.js 白名单加 user-agent（配合 UA 定制）
- curl 生成器提示注释误报修复：hint 判断补查 cookieString（多凭据模式下不再误报“未捕获下载凭据”）
### 变更
- **direct 模式限制（重要）**：浏览器 fetch 禁止修改 User-Agent，direct 下大文件带有效 cookie 仍会
  401 —— 夸克大文件下载必须走代理模式（自建/CF），UI 弹窗提示已覆盖
### 备注
- 验证：UA 穿透证据链完整（E2E 拦截 SPA→代理 body 含 UA+Cookie ✅ + 代理转发日志确认到达夸克 ✅）；
  fix1 分流 E2E 通过（demo1 182MB 直接弹 CookieInputModal，CookieWarnModal 未出现）✅；
  Tzz 真机验证：真实 cookie + 代理 → download **200** ✅（2026-08-26 21:19）
- 单测 14/14 ✅（md5 注释行 ×5 + cookie 分流 ×9：小文件 __pugs / 大文件只 __puus / 无 __puus 不返回 /
  无 pugs 仍只 __puus / 绝不包含 __pus 与完整串）；typecheck ✅ build ✅
- **qk-guestTurn 验证（2026-08-27）**：单测 13/13 ✅（guestMode 不带登录整串/带 pugs/导出 __pugs +
  aria2 拼参/gopeed 合并 opts）；E2E 三场景 ✅（开+小文件=游客请求无整串 / 关+小文件=弹窗 /
  开+大文件=弹窗）；E2E 导出 ✅（curl 含真实 __pugs= + # hash: + 无 __pus，游客 CDN dl-guest-zb-u 匹配）
- 隐秘参数 modal 已核查：HiddenVolumnModal 与 uc/quark 两 registry 均泛化（各自 body），未见 UC 话术串场
- 待 Tzz 审 diff → 推送 + tag v1.1.9.final（按协作协议先 diff 确认再推）

## [v1.2.0-wip] 2026-08-25 —— backend 骨架 + 管理面板（v0.1.0）+ 夸克登录态弹窗修复
### 新增
- **backend/ 落地（backend/README.md + selfhost-node.md §3 结构）**：
  - 双 listener：proxy（/api/proxy，可对公网）+ webui（/api/web/* + 静态，硬绑 127.0.0.1）
  - 核心转发协议与 CF 版 proxy.js 完全兼容：X-Proxy-Token（timingSafeEqual）→ 白名单 →
    限频（可选）→ 转发；回传 x-pugs/x-quark-pus/x-quark-puus；set-cookie 自动合并回账号池
  - 存储：node:sqlite（内置，替代 better-sqlite3 草案）+ AES-256-GCM（secret.key 权限 600）
  - 账号池字段与 SPA 弹窗对齐：quark 整串（__pus/__uid/__puus）· uc __pugs；
    仅 prase/download 注入登录态（scan 保持游客，对齐 split 默认矩阵）
  - 调用级脱敏落库（凭据值 SHA-256）+ 完整头进 data/tmp/debug-*.log（600，7 天轮转）
  - WebUI 七页（Preact + vite，构建产物 40KB）：基础信息/网络配置/实时日志/数据看板/
    插件管理/系统终端（占位）/系统配置（账号池 + 白名单 + 限频 + 通知 + CDP）
  - WebUI 安全四件套：Host 校验 + Origin 校验 + CSRF + 随机端口；高危操作（白名单增删/
    账号池修改）需二次输入令牌确认；令牌轮换打印到控制台
- **夸克 23018 → CookieInputModal 链路修复**（真机复现 + E2E 验证）：
  - 根因：ProxyTransport 对非 2xx 响应提前抛 TransportError，把 HTTP 400 壳里的
    业务码 23018 吞掉 → needLogin 匹配不到 → 登录态弹窗永远不触发
  - 修复：代理响应改为原样透传状态码 + body（与直连同规格），业务码由 adapter 从 body 解析
- 顺带修复：quark/cookies.ts 存储键被损坏为含省略号字面量（pan-we…e:v1），还原为
  pan-web:quark-cookie:v1 / pan-web:quark-pugs:v1
### 变更
- 技术栈偏差（记录在 backend/README.md）：存储用 node:sqlite（≥22.5 内置，Termux 友好）
  替代 better-sqlite3；WebUI 用 Preact + 自定义 CSS（对齐 SPA 风格）替代 Tailwind/daisyUI
  （API 契约不受影响，后续可换肤）
### 备注
- 验证：backend API 冒烟（鉴权/账号池/白名单/限频/转发/落库）✅ + WebUI 七页 headless
  冒烟 ✅ + SPA 全链路（夸克分享 → CookieWarnModal → CookieInputModal）经 backend 代理 ✅
- 待实现（后续板块）：排队/插件加载器/split+monitor/终端/CDP/一键脚本/备份脚本

## [v1.2.0] 2026-08-23 ——selfhost-node 设计稿定稿（backend/ 自托管代理，里程碑）
### 新增
- **docs/selfhost-node.md 设计稿**（初版 STRUCTURE + 设计约束，板块化开工依据）：
  - 定位：与 CF 版 proxy.js 协议完全兼容的本地/内网转发代理（SPA 换地址即切换）
  - 技术栈：Node ≥20 零框架 + better-sqlite3 + AES-256-GCM + React WebUI + puppeteer-core(CDP)
  - 核心能力：完整响应头记录（魔鬼测试刚需）、cookie 池加密存储、分流开关、
    过期/风控通知、排队机制（家庭组）、数据看板 + 单次调用 trace
  - 安全红线：登录态默认全关（公网强制游客）；系统终端公网默认关；webui 首启一次性令牌
  - 开工顺序：骨架 → 核心转发 → 存储 → WebUI → 插件 → 排队/终端/文档
### 变更
- 基线：新建 panhub_praser_1.2.x 工作目录（拉取远程 master 最新，已含夸克 cookie 修正）
- .gitignore 纳入 .wrangler/
### 备注
- backend 真实落地时打 tag v1.2.0；本条目为设计稿里程碑记录

## [v1.1.9.1] 2026-08-23 ——夸克登录 cookie 修正（真实 key：__pus/__uid/__puus）
### 修复
- **夸克登录态 cookie 认知修正**（Tzz 实测反馈）：旧版 sdid/up/wk 是拍脑袋假 key。
  交叉验证 alist/boxplayer/nfd/linkswift：真实核心是 `__pus`（主凭证）+ `__uid` +
  `__puus`（3h 会话，服务端响应自动刷新，请求缺失时才下发新值）；
  `.pan.quark.cn` 域十几个 cookie，找最小集合不划算 → **整串粘贴原样发送**（社区最佳实践）
- CookieInputModal 支持整串模式（wholeString）：单大输入框 + 自动检测关键 key 提示；多键模式保留
- 适配器自动合并 __pus/__puus：proxy.js 回传 x-quark-pus/x-quark-puus，scanner 收口合并回本地
  （alist 同款刷新逻辑，用户不用管 3h 过期）
- 导出 cookieString = 登录整串 + 同响应 __pugs
### 变更
- CookieInputRequirement 加 wholeString 字段（整串 vs 多键渲染）
- quark/cookies.ts 存储改整串（getQuarkCookieString/setQuarkCookieString）

## [v1.1.9] 2026-08-23 ——适配夸克网盘（第二个适配器）
### 新增
- **夸克适配器**（src/adapters/quark/）：短链/长链识别、token → 目录树（scanner）→ 下载直链（prase）
  - scanner 三连全部零 cookie（游客可读目录树）；分享根包装层自动下钻（等价网页视图）
  - prase：直链 + 同响应 __pugs（§12 同 UC，CDN 无 pugs 即 412）；download 响应免费带 md5
  - **游客大小限制约 50MB**（实测 41MB 可 / 51MB 23018）；大文件强制登录 → 登录态 cookie
- **登录态 Cookie 填写弹窗**（CookieInputModal）：夸克 23018/31001 时自动弹出
  - sdid/up/wk 填写框 + 懒人导入（Netscape / JSON / Header 字符串自动识别，支持文件选择）
  - 红点提示登录态 cookie 风险（公用代理自担账号安全）+ get cookies.txt locally 插件链接
  - 保存后自动重试失败文件；设置-弹窗开关新增「登录态 Cookie 填写弹窗」
- 传输层：DownloadResult/ExportFile 支持 cookieString（多凭据整串）；LinkResult 透传 errorCode（core 零网盘依赖，duck-typing）
- proxy.js：白名单追加 quark.cn；cookie 头放行（登录态需要，SPA 弹窗已红点警告）；x-pugs 捕获同 UC 通用
- 首页网盘表：夸克点亮（PanTable available）
- 文档：docs/reverse-notes-quark.md（真机逆向笔记）；tests/quark-real.spec.ts（真机 13 项）、
  tests/quark-proxy.spec.ts（本地 wrangler 代理链路 14 项，白名单/cookie 透传/x-pugs 回传/23018 透传）
### 变更
- 适配器注册表注册 quark（detect 顺序：uc 优先，域名不冲突）
- 导出任务（curl/aria2/gopeed）cookie 注入兼容 cookieString（登录串 + __pugs 整串）
### 备注
- 登录态 cookie 真实下载 8.5GB 未实测（无账号）；按 linkswift 观察设计，待 Tzz 真机确认
- 大分享真机验证：3efb93ba1306（Windows 镜像，8.5GB ISO）；小文件：cdccb82aafe6（影视仓接口）

## [v1.1.8.1] 2026-08-23 ——Gopeed 推送修复（REST 契约真机实测）
### 修复
- **Gopeed 推送失败**（Tzz 实测无法推送）：旧实现把 UI 导入格式 `{version,tasks}` POST 到
  /api/v1/tasks，v1.9.x 不认 → `code:1002 param invalid: rid or req`。
  改为 REST 契约（gopeed-js 源码 + v1.9.3 无头服务端实测）：
  - 批量：POST /api/v1/tasks/batch，body `{reqs:[{req:{url,extra:{header:{Cookie}}},opts:{name,path}}]}`
  - 鉴权：X-Api-Token 头（旧 Authorization: Bearer 直接 401）
  - 连接测试：GET /api/v1/info（旧 /api/v1/version 404）
  - 保存目录：opts.path 绝对目录；用户未填保存路径时先取 GET /api/v1/config 的 downloadDir 作 base，
    keepStructure 才能落到正确目录（否则相对路径会相对 gopeed 进程 CWD）
- **导出 gopeed-tasks.json 同步改 REST reqs 格式**：旧 `{version,tasks,store}` 是早期 UI 导入格式，
  v1.9.x 网页端已无此导入（bundle 里零匹配），导出的 JSON 现在可直接 `curl -d @文件` 推送
### 变更
- tasks/gopeed.ts：buildGopeedTasks 改产出 REST batch payload（extra.header 单数键，§12 Cookie 注入不变）
- tests/gopeed-real.spec.ts 新增：连真 gopeed 端到端（info/推送/落盘/回显源站验证 Cookie 实际发出）

## [v1.1.8] 2026-08-22 ——连接&推送本地下载器（直推任务，不再只是导出文件）
### 新增
- **推送下载器**按钮（资源列表工具栏，导出按钮旁）：把勾选文件的直链任务直接推到本地下载器，无需复制/导入
  - aria2 / motrix → aria2 JSON-RPC（aria2.addUri，同协议；motrix 为内置 aria2 内核 16800）
  - gopeed → Gopeed REST API（POST /api/v1/tasks，v1 批量 payload 与导出一致）
  - 逐任务推送并统计成功/失败，首个网络错误（未启动/地址错/跨域拦截）即中止并给出人性化提示
  - 推送前与导出同一套校验（未选中/含过期 → 弹窗或 toast）；§12 按文件注入 __pugs 与导出完全一致
  - 支持 RPC 密钥：aria2 用 token:<secret> 前置参数；Gopeed 用 Authorization: Bearer <token>
- **测试连接**按钮（连接本地下载器弹窗）：aria2.getVersion / Gopeed /api/v1/version，结果内联展示
- 连接配置保存后立即生效（结果页重新读取，不再用旧地址推送）
- tests/push-downloader.spec.ts：端到端实测（本地真 aria2c 下载验证目录结构/Cookie 注入 + Gopeed mock）
### 变更
- tasks/aria2.ts 抽出 buildAria2AddUriParams、tasks/gopeed.ts 抽出 buildGopeedTasks（导出与直推共用同一套 dir/out/header 逻辑，避免两处漂移）

## [v1.1.7] 2026-08-22 ——隐秘参数+etag试探（还有大量细节）
### 新增
 - 隐秘参数按钮位置：大小和创建时间两栏之间挤一下（不污染padding，创建时间向右移动）符号是纯文本'<>'
 - resultpage全选反选清空基础上
- “选中所有绿色标记”“选中所有黄色标记”“选中所有红色标记”“选中所有未解析”“选中所有已过期”
- export从不起眼的toast也加上弹窗模式
- 自动保留上次目录折叠状态，之后如果被复用开启弹窗提示

- 偏好设置可以导出备份
### 变更

- resultpage显示
- 资源列表获取于xx刷新之后改为“资源列表首次获取于xx最后刷新于xx”
- 优化praser-status处于yellow也可以被单文件解析

### 移除

- 默认下载/解析，设置选项和参残余功能代码【根本没有功能代码】
- 自动关闭标签页，设置选项移除，原有功能代码不动
日后单独做一个**node转发代理**，支持一键部署到任何公网或者内网的设备上。CORS的modal选项保留，解析通道保留direct选项，或许有人真的使用不校验请求头的定制浏览器？
### 更新的设置选项：

- +UAC列表请更新，加一行etag种类/支持情况

- +选项：文件夹属性 sub scanner受到风控影响无法做到完整遍历，因此只显示该文件夹下面的一级文件格式和一级文件夹个数
	显示etag sub 单文件的校验和
	是否“显示上次HH:MM剩xHxM”做成按钮“显示详细的解析时间和有效期”
	默认终端类型（不填则使用当前浏览器UA），下拉表单加预设（感谢linkswift）
	export包含黄色标记是否弹窗提示，sub 打开显示弹窗关闭显示简略toast
	RestoreCollapsedStatus，复用期间内恢复上次折叠状态
##### 设置下面折叠一些高级功能（小标题写高级功能），总开关默认关闭

+aria2导出额外参数，默认留空
+gopeed导出额外参数，默认留空
+选项：显示隐秘参数按钮
+二级选项：显示按钮功能和部分参数的含义sub弹窗提示。默认开


---

## [v1.1.6] 2026-08-19 —— 优雅修复风控 0B 文件夹 + adapter 规范（细节优化）

> 1.1.x 阶段说明：不再区分“哪个版本新增什么功能”，全部是细节优化（水军）；
> 1.2 起主力转向 linkswift / oss+sig 协议研究，不再做 UI/日志/偏好等基础设计。

### 修复

- **大宗扫描风控优化**：同目录翻页节流 250ms + 并发 3 降到 2（游客态批量 scanner 风控会
  “集群”出现，集中到一整个二级目录）；进度条保持 a/b 形式（a=已获取到名字的文件数，
  b=已知存在的文件数，b 可突变、a 接近匀速增加）

### 新增

- **0B 文件夹「转到此文件夹」**：风控导致目录树拉取失败的伪“空文件夹”（children=undefined
  且 size=0）行出现该按钮，生成跳转长链接（`drive.uc.cn/s/xxx#/list/share/fid-name/...`，
  与分享页地址栏一致），新建一个相关联的链接任务二次获取该文件夹资源列表
  - 跳转前提示弹窗（设置 → 弹窗开关 → 跳转到文件夹是否提示，默认开）：
    「文件夹标识符来自上一次获取资源目录的缓存…」；sub 说明“支持二次获取资源目录，
    此时会新建一个相关联的链接任务”
  - stoken 从大宗 scanner 入库数据（足迹 trees 快照）获取，没有才调 token 接口；
    jumper 扫描根节点是目标文件夹（isRoot=false，不带 banner/share 扩展字段），
    不覆盖 trees 根快照；依旧一次性解析完毕，不使用懒加载
  - HomePage 输入框自动识别长链接（selector），手动粘贴跳转长链接同样走 jumper 流程
- **显示属性设置**：文件夹行显示内部文件和子文件夹个数（设置 → 默认方式 → 显示属性）
- **开发日志**：目录树打印 fid（0B 文件夹排查/手动拼跳转链接用；导出目录树 md 不含）；
  jumper 流程日志（跳转到/扫描暂存区/收到jumper任务/已找到目录 折叠块可复制）；
  新任务 link 日志最早写入 `HH:MM:SS from '文件夹绝对路径' in '原任务标题'`

### 变更

- **adapter 规范**：`adapters/` 按网盘子目录整理（uc/），每个网盘一般只需
  types.ts（静态属性）/ registry.ts（组装）/ scanner.ts（扫描能力）/ cookies.ts（凭据）/ 
  jumper.ts（跳转）/ selector.ts（链接识别）六个文件；云端策略变动只需改对应子目录
- uc.ts → uc/scanner.ts；ucPugs.ts → uc/cookies.ts；PanAdapter 新增可选
  buildJumpUrl/parseJumpUrl（0B 文件夹跳转能力）

---

## [v1.1.5.3] 2026-08-18 —— 导出路径修复与 fid 复用落地（细节优化）

> 基于 1.1.5.2 工作副本的修复批次；1.1.5.2 的防暴力刷 prase 改动按约定不写 changelog。

### 修复

- **curl / aria2 / gopeed 批量导出无法使用**：目录树 path 形如 `/dir1/sub/file.zip`，
  导出时目录段开头带 `/` 被 shell / aria2 / gopeed 当作根目录绝对路径；三处 dirNameOf
  统一剔除开头 `/`（根目录文件仍平铺到 outDir / 默认目录）
- **cloudflare 温馨提示弹窗不出现**：原判定是「手动终止与重试发生在相同 MM:SS」，
  真实点击必然跨秒导致永远不触发；改为「终止后 5s 内重试」窗口（pages.dev 代理 + 手动终止场景）
- **批量解析选「算了吧」后文件状态不变红**：整批请求共用一个 cookie，终止即整批失败；
  现在批量与单文件一致，全部标红（status:red 手动终止 + 重新解析按钮），已可复用的直链不受影响

### 新增

- **prase 结果按 fid 落库复用**（开发日志/足迹体系）：解析完成的 oss+sig + 同响应 __pugs +
  获取时间/终止标记存入 footprint 新 store（shareId::fid），刷新/重进分享自动恢复 ——
  未过期直链直接可导出，不再请求接口（proxy 被恶意刷爆时尤其有用）；读不到/已过期则
  正常显示解析按钮。手动刷新资源列表 / 删除链接 / 清空足迹时同步清理
- 开发日志：目录树 / 解析结果折叠块加「复制」按钮，一键复制全文方便贴给开发者分析；
  解析结果每行附 oss 直链 URL
- 设置 → 资源复用窗口 sub 提示：建议按直链过期时间最短的云服务设置（UC 实测 3-6h）
- UAC 表新增「oss/sig 较小有效期」行（先填已知：UC「直链 3-6h/Cookie 3h」，实测）

### 变更

- 移除结果页每个 file 的 status:xxx 文本标签（保留四色行底色与 重试/续杯/重新解析/解析 按钮）
- 开发日志术语：ls 改为 scanner（获取资源列表），prase（解析下载方式）不变

---

## [v1.1.5] 2026-08-17 —— 复用落地与直链状态标签（细节优化）

> 1.1.x 阶段说明：不再区分“哪个版本新增什么功能”，全部是细节优化（水军）；
> 1.2 起主力转向 linkswift / oss+sig 协议研究，不再做 UI/日志/偏好等基础设计。

### 重点突破：复用为什么要有

这是一个很不起眼的功能，只是为了应对分享者很懒、把一大堆文件一股脑分享出来。
如果不小心刷新页面或者浏览器闹脾气，你无需再等待漫长的“资源列表加载”。
一次加载默认一小时有效（设置 → 资源复用窗口可改；云服务商最多允许多长时间未知）。
层数很多的文件夹容易出现 0B 空文件夹问题，后续会修复。

### 已知问题

- ~~**oss+sig 复用失败（列表复用成功，不是问题）**：直链是敏感凭据，故意不落暂存区~~
  （v1.1.5.3 已推翻：改为按 fid 落库复用，见 1.1.5.3「新增」；敏感凭据仅存本地 IndexedDB）
- 目录层数很多的分享容易出现 0B 空文件夹问题，后续修复

### 新增

- 文件行直链状态标签：`上次HH:MM剩xhxm` / `上次HH:MM已过期` / `上次HH:MM手动终止`，
  替换原「用导出命令下载」（含其 title 属性）；已过期/手动终止的文件行出现「重新解析」按钮，
  顶部倒计时移除（下沉到文件行）
- 解析结果留痕：prase 完成后把每个文件的 路径/大小/格式/凭据有无/剩余时间 写入全局日志（折叠块）
- cookie 状态弹窗：复制按钮旁新增「当前长度 xxx」按钮；话术改为「该 cookie 叫做 __pugs，
  标准长度 208，请自行核对后继续；你可以在设置中关闭该提示」
- cookie 弹窗选「算了吧」= **主动终止解析**（原为跳过继续）：toast「用户主动终止解析」，
  单文件写「上次HH:MM手动终止」标记 + 重新解析按钮，开发日志同步
- aria2 保留目录结构导出修复：input-file（pan-web-tasks.txt）此前从未被导出（1.0 遗留）；
  改为每文件一条带 `--dir="相对目录"` 的完整命令（aria2 自动建目录），单文件导出
  （浏览器默认拦截连续下载两个文件，双文件方案废弃）
- curl 支持保留目录结构（--create-dirs + 相对目录输出路径），跨文件夹不再拦截 →
  移除 BatchWarnModal（批量解析仅支持 aria2/gopeed 弹窗）及其设置开关
- 操作按钮人性化：失败 →「重试」；成功但已过期 →「一键续杯」；手动终止 →「重新解析」
- 导出后提醒：若部分直链剩余有效期不足以支撑完整下载（按 1.5 MiB/s 参考速率估算），
  导出完成几秒后追加一条黄色 toast 提示尽快下载或续杯

### 修复

- 导出任务失败弹窗文案改为排查指引：检查所选部分是否为空；【重新解析】= 上次已过期；
  仍失败请刷新资源列表（会清空所有暂存区 oss 直链）
- 导出只统计窗口内未过期直链；「重试失败项」覆盖已过期直链
- 设置面板移除冗余项：目录树格式、目录树详细程度（file 大小 / etag / 分享时间 /
  用户存储时间 / 平台存储时间）
- 直链新鲜度判定统一走 utils/linkStatus：复用窗口 + oss Expires（60s 边际）双判定
  （点赞项：按 oss 自带 expire 计算 60s，而非 prase 操作时间）

### 变更

- AGENTS.md 纳入协作协议：先 diff 确认再推送（不 -f）；Tzz 不改源码时只动注释，改源码会先说明；
  1.1.x 细节优化期，版本不再区分功能

---

## [v1.1.3] 2026-08-16 —— pugs 同响应绑定（架构级修复）+ 单文件解析 + CF 能力验证

### 新增
- 单文件解析：目录树操作列原“复制直链”位置改“解析”按钮（未解析/失败时显示；成功后提示用导出命令下载）
- docs/reserve-note.md（预留笔记）：pugs 同响应绑定实测矩阵 / CF 代理能力验证 / 项目定位 / 方案评估
- 代理跨域部署补 `Access-Control-Expose-Headers: x-pugs`（GitHub Pages SPA + pages.dev 代理时浏览器才能读到捕获值）

### 修复
- **架构级：__pugs 与直链同响应绑定**（实测：同环境跨请求混用也 403 ucidMd5 invalid）——
  DownloadResult/LinkResult/ExportFile 增加 cookie 字段，curl/aria2/gopeed 导出按文件注入各自响应绑定的值；
  废弃“全局单一 pugs 注入所有文件”（多批解析时只有最后一批能下）
- **顺序固化**（single-link 示例日志核对）：获取资源列表（ls）= 游客态浏览，不再弹 cookie 提示；
  cookie 状态弹窗移到结果页“获取下载链接”阶段（解析时才需要，且与直链同响应）
- UacTable 回滚 v1.1.2 改名与全局日志改动（label 恢复“读取 Cookie 警告弹窗”，副标修正“UC 下载需 __pugs，默认开”）

### 变更
- CookieWarnModal：完整明文显示捕获值（不再截断）+ 复制按钮（社区开发者调试，开关默认开）
- v1.1.2 “设置项改名”作废（见上 UacTable 回滚）；弹窗标题/文案保留 v1.1.2 版本
- 移除“解析前新标签预热”调用（§12 实测：跳转取 cookie 对导出链路无意义；浏览器直下已移除）
- reverse-notes-uc.md 追加 §12；changelog 前序条目相应修订

---

## [v1.1.2] 2026-08-16 —— cookie 状态弹窗 + 全局日志 + 架构纠偏（Tzz 反馈）

### 新增
- 全局日志（开发调试）：历史页十盘 banner 下方新增可展开 banner，明确标注“仅用于开发调试，不会过滤隐私信息”；记录服务启动/偏好变更/解析生命周期/代理测试 POST/导出 merger
- cookie 弹窗改造：如实显示本次捕获值（`双下划线pugs=…` 或空），空值时给出供应商排查话术（cookie 存储限制/无痕/AdGuard），按钮【算了吧】【我已阅，继续】
- ~~设置项改名：读取 Cookie 警告弹窗 → cookie读取状态警告（默认开）~~ → v1.1.3 已回滚改名，仅保留“默认开”

### 修复
- **架构纠偏**：`pugs.ts` 从 core/ 移入 adapters 层（`src/adapters/ucPugs.ts`），transport 回归“零网盘依赖”；__pugs 捕获收口到 UC 适配器 request()
- 历史导出空括号 bug：数据源从 links store 改为 records store（与时间轴一致，含成功/失败状态）
- 移除浏览器直下/复制直链（UC referer 白名单拒绝第三方源，§10.1.4），目录树改为提示“用导出命令下载”

### 变更
- 代理连通测试写入全局日志（打印 POST 方法与目标）
- reverse-notes-uc.md 追加 §11（2026-08-16 决策与实测）

---

## [v1.1.1] 2026-08-15 —— UC 下载层 __pugs 令牌（联调实测）

### 新增
- 解析前“读取 Cookie 提示”弹窗（默认开，设置可关）：确认后新标签预热分享页，自动提取 __pugs 写入浏览器 jar（reverse-notes-uc.md §10）
- CF 代理捕获 upstream `set-cookie: __pugs=` → 回传 `x-pugs` 头 → SPA 存 localStorage（§10.2 代理捕获通道）
- curl/aria2/gopeed 导出自动注入 `Cookie: __pugs=...`（缺失时 curl 附带提示注释）
- `_headers`：全局 `Referrer-Policy: no-referrer`（UC checkplay 只放行 drive.uc.cn 或空 referer，§10.1.4）

### 修复
- UC 下载层认定从“游客零 cookie 可下”修正为“需 __pugs 人机校验令牌（游客态即可，3h 过期）”（§10）

### 变更
- reverse-notes-uc.md 追加 §10（__pugs 唯一必需 cookie + 双通道获取 + referer 白名单实测）
- UAC 表：UC needsCookie 置真、弹窗开关文案更新

---

## [v1.0.2] 2026-08-14 —— 待 Tzz 核验

### 新增
- 解析记录写入分享内容标题（ParseRecord.title = 首个文件/夹名），历史页标题不再回退裸链接
- 历史页："全部"筛选时条目前置网盘 logo（public/logos/<id>.png，缺省回退短字）

### 修复
- CORS 自动跳转后 30s 自动关闭新标签页并回到本站（桌面用户不再被晾在分享页）

### 变更
- 路线图新增：索引导出机制（本地足迹/历史 JSON 索引导出，供 clouddiskpub_subscription 项目对接）

---

## [v1.0.1] 2026-08-13 —— 小毛病修复 + 历史页

### 新增
- 历史页（#/history）：HISTORY 时间轴 + 十盘筛选（尾部"全部"）、标题取首个文件（夹）名多文件加"等"、
  同链接多次解析折叠展示、操作三件套（修改备注/重新解析/下载日志）
- LinkRecord.note 备注字段 + updateLinkNote；ParseRecord 全量查询 listAllRecords
- CORS 拦截兑底：偏好开关"CORS 拦截后自动跳转"（默认开；关=先弹窗 CorsJumpModal）——PC 端无书签可测
- PanTable 支持盘 logo（public/logos/<id>.png，缺省回退短字）+ 筛选模式 + 尾部"全部"
- 仓库地址按钮 GitHub 图标；Header 新增"查看历史"入口

### 修复
- 弹窗头部随内容滚动 → .modal-head sticky 固定（偏好设置/连接本地下载器等全部弹窗）

### 变更
- 重新解析：回输入页自动填充并触发解析

---

## [v1.0.0] 2026-08-13 —— v1.0 完结

### 新增
- 适配层：PanAdapter 接口 + registry + UC 适配器（token → detail → download 三连，零 Cookie）
- core：treeWalker（递归建树/分页/并发 3/大小聚合/失败容错）、linkFetcher（15 个/批 + 1s 节流）、errors（错误分类）、preferences（localStorage）
- footprint：IndexedDB 四件套（链接/树快照/解析记录/日志），日志 5MB 轮转 + 凭据删除线脱敏
- tasks：aria2（命令/input-file/RPC）、gopeed JSON、curl 命令、统一导出 + 目录树 md
- UI 1.0：输入页（分享文案提取/自动识别高亮/十盘表格）、结果页（目录树/勾选/批量直链/倒计时/失败重试/跨文件夹限制）、设置面板（UAC/默认方式/足迹）、弹窗全套（连接本地下载器/登录跳转/批量警告/Cookie 警告/重复点击提示）
- 文档：README、changelog、ai-usage、migration-linkswift、LICENSE(GPLv3)
- CSP 冒烟测试通过：drive.uc.cn 主文档无 CSP，书签注入路径可行

### 修复
- registry.ts 模块初始化 TDZ 崩溃（registerAdapter 先于 adapters 声明）——headless E2E 抓出
- 适配器 detail 响应 metadata（含 _total）位于 JSON 顶层而非 data 内

### 变更
- 项目更名 panhub_praser（package.json / 标签页标题）
- .gitignore 纳入 node_modules/、dist/

### 待办（v1.0 已知）
- bookmarklet（步骤 7）：inject/bridge/overlay + 独立构建，部署后按 Tzz 的 iframe 体验方案调整
- 23018 游客大小限制临界值待实测确认
- 提取码分享（passcode）全流程待实测

---

## 路线图（期待）

### 1.x —— 更多网盘适配
- 按 src/adapters/README.md 接入：百度 / 夸克 / 阿里 / 移动 / 天翼 / 城通 / 123 / 迅雷 / 光鸭
- 各盘 UAC 表真实值回填（转存/登录/限速/Cookie 需求）
- 需要登录的盘：Cookie 警告弹窗 + 登录跳转联动（组件已就位，接入时启用）
- 适配器单测（tests/uc.spec.ts 等，mock 响应）

### 2.0 —— FastAPI 后端（可选自托管）
- 用户填写后端地址即用：服务端代理解析（绕 CORS）
- Cookie 池：**不提供**，仅预留管理面板 + 用户账号鉴权
- 尝试绕过 IP 限制（多出口代理池方向）
- 口令转链接协议「敬请期待」

### 其他方向
- 本地下载器 RPC 直推任务（aria2.addUri / Gopeed API，配置弹窗已预留）
- 下载器 ETA 跟踪（偏好 trackEta 已预留，轮询 aria2 RPC 进度）
- 目录树懒加载（大目录按需展开子层）
- TUI 可视化进度（v1.1 交付）
- **索引导出机制**：本地足迹/历史 JSON 索引导出（TODOLIST，与 clouddiskpub_subscription 项目对接）
