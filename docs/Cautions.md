# 坑位日志（Cautions）

> 用途：本仓库分层多（`core` + `adapters` + `transport` + `hop`），链路里的 bug 常常不是单点故障，
> 而是几层叠加出来的「灵异现象」。这里集中记录**已查实根因**的坑，避免下次「触发了却不知道为什么」。
>
> 收录规则：只写复现并定位过的；每条按 `现象 / 根因 / 修法（或规避） / 教训` 四段，**时间倒序**（新的在前）。
> 后续新坑持续追加，旧条目保留（历史即证据）。

---

## 2026-10-02 迅雷 captcha_sign：盐表与身份必须配套，混搭必败

【现象】用 webapp 抓包里的 12 条盐 + `client_version 1.93.6` 复现不出抓包里的 `captcha_sign`（拿两组真机样本反推 1280 种变体全不中，从拼串顺序到盐序/大小写/版本都试遍）；
把「web 的 client_id + alist 的盐表」混搭去 `captcha/init`，服务端回 `invalid_argument / invalid captcha_sign`。
【根因】`captcha_sign = 多轮 md5( client_id + client_version + package_name + device_id + timestamp + 盐…)`，
**盐表是随「客户端身份三件套」配套下发的**：换 client_id/version/package 之一，盐表也必须换。
webapp 的算法被高度混淆且随版本更新（linkswift 里写死的盐表早已失效，它今天还能跑只是因为脚本从 localStorage 复用旧的 captcha_sign）。
alist 的 android 身份（`Xp6vsxz_7IYVw2BB` / `8.31.0.9726` / `com.xunlei.downloadprovider` + 它自己的 10 盐）**一次通过**。
【修法/规避】`src/adapters/xunlei/types.ts` 把身份三件套 + 盐表**同一处声明**（借 alist 在野身份，Tzz 已认可），
device_id 随机生成后持久化，**不要**用真实/浏览器用过的 device id；
`captcha/init` 失败先怀疑三者是否配套，别去调拼串顺序。
【教训】逆向签名时先用**两组真机样本**双向校验（只对一组可能碰巧）；
「算法对但签不过」通常是**输入配套**问题，不是算法问题。

## 2026-10-02 迅雷 share/detail 默认 limit=30 会把大宗目录截断

【现象】大宗分享（36 个一级对象）用 `limit=30` 拉 detail，只回 30 条且 `next_page_token` 非空；
照旧按「30 条 = 一屏」处理会**静默少 6 条**（与遍历层静默丢数据同类后果）。
【根因】迅雷是游标分页（`page_token`/`next_page_token`），单页上限受 `limit` 控制；`limit=50` 实测可一次拿满 36 条。
【修法/规避】scan 策略：**默认 30 跑一次 → `next_page_token` 非空则改 `limit=50` 重跑**；
仍非空才用 `page_token` 继续翻（此时对象数已超 bulk 阈值 100，正好一并覆盖）。
一级对象数可直接取 `file_num`（分享根）/ `parent.params.file_property_count`（子目录），不必数数组。
【教训】接游标制网盘先做一次「同目录不同 limit」的对照实测，别沿用页码制网盘的经验值。

## 2026-10-02 迅雷 `pass_code_token` 不能绕过转存

【现象】想用分享 `pass_code_token` 直接取分享文件直链，避免转存：
`GET /drive/v1/files/{分享内 id}`（不带 Authorization）→ 401 `unauthenticated`；
`?space=`/`?with_audit=true` 同样 401；自造的分享域端点（`/share/files/{id}`、`/share/file/{id}`）→ 404 `not_found`。
【根因】`/drive/v1/files/{id}` 只认「调用者自己盘里」的文件，直链 `web_content_link` 是在**你的账号上下文**里生成的；
分享里的文件属于分享者，必须先 `POST /drive/v1/share/restore` 转存进自己盘（`trace_file_ids` 给新 id）才能取直链。
【修法/规避】适配器固定两段：scan（游客 + captcha）与 restore+download（登录态）；
转存要带 `settings{item:restore_path}` 先设落地目录，且**迅雷不允许接收者是分享者**（用分享响应的 `user_info.user_id` 提前拦）。
【教训】「分享态能读目录」≠「能取直链」；判断某网盘能否免转存，看取直链端点是否要求登录态上下文，而不是看 list 接口。

## 2026-09-11 阿里云盘直链「刚解析就显示过期」

【现象】prase 成功、直链实际能下，但 UI 立刻标「已过期」。
【根因】三连坐：① `AlipanDownloadUrlResult` 字段真名是 `expiration`，代码误写 `expire_time` → `undefined`；
② 回退解析器 `ossUrlExpiryMs()` 只认 UC/夸克签名形态（`Expires=` / `auth_key=`），不认 `aliyundrive.cloud` → `null`；
③ `linkStatus` 兜底策略「无过期信息 = 过期」。三层都不报错，只是集体判错。
【修法/规避】`src/adapters/alipan/types.ts` 补 `expiration/content_hash/…`（保留 `expire_time` 兼容）、`scanner.ts` 用 `expiration ?? expire_time`，并给该兜底策略加注释（宁白不绿）。
【教训】接新网盘最常见的错是**字段名猜错**；fallback + 兜底会把错误静默下沉到 UI，排查要顺着 UI 反推三层。

## 2026-09-11 阿里直链浏览器直开不了：Referer 与 `_headers` 的两难

【现象】阿里 OSS 直链在导出命令里能下，浏览器地址栏直开 403/400。
【根因】根 `_headers` 的全局 `Referrer-Policy: no-referrer` 是给 UC 设的（UC CDN 只放行 uc 域或空 referer）；
阿里直链要求**精确** `https://www.alipan.com/`，而浏览器导航产生不了跨站 referer（策略只能输出本站/空/origin）。
【修法/规避】两条线不冲突，互不修改：保留 `no-referrer`，阿里直链只走「导出命令注入 Referer」通道（`ALIPAN_DOWNLOAD_HEADERS`）。
【教训】全局响应头是多网盘共用的资源，动之前先确认它在替哪个网盘兜底。

## 2026-09-11 阿里错误码是点号形态

【现象】`QuotaExhausted.Drive`（HTTP 400）没命中中文文案表，用户看到原始英文码。
【根因】阿里用 `<枚举>.<子项>` 点号形态，文案表 key 是下划线风格（`QuotaExhausted_Drive`）。
【修法/规避】适配器统一做 `.` → `_` 归一，两种写法都能进表。
【教训】错误码做 key 归一化，别指望上游只给你一种拼法。

## 2026-09-09 写脚本时被脱敏管道改了语法（headtest.mjs）

【现象】脚本里 `Authorization: <变量>` 形态落盘后被替换成 `***` → 语法错误，跑起来才炸。
【根因】工具链对疑似凭据的行做脱敏，替换发生在**写路径之后**，diff 里看不出异常。
【修法/规避】写完含该模式的脚本先 `grep -n '\*\*\*'` 校验；已踩到的用 perl 原地修回。
【教训】脱敏是好事，但它会改写你的源码——含凭据模式的脚本，落盘即验。

## 2026-09-08 阿里 access_token 只有 2 小时

【现象】凭据放着不用，回头再请求就是 401 `AccessTokenInvalid`。
【根因】JWT `iat → exp` 实测 ≈2h（`share_token` 同 2h；直链更短，15min）。到期就是到期，不会自动续。
【修法/规避】别按「长期凭据」设计：账号池要带刷新通道（CDP / refresh_token），UI 要允许随时粘贴新凭据。
【教训】接入新网盘第一件事是量凭据寿命，再定存储与刷新策略。

## 2026-09-08 `get_share_link_download_url` 是网关级死接口

【现象】调用恒 410、空 body。
【根因】11 种参数/头/域组合全试过，全是 410——接口已下线（linkswift config 里的旧 URL 是死代码）。
【修法/规避】不要试图「找到对的调用方法」；分享文件必须先转存到自己 drive 再取直链（两跳链路）。
【教训】从旧项目抄来的 URL 要先验证存活，再花时间对齐参数。

## 2026-09-08 分享页 SPA 会清掉外来的 localStorage token

【现象】往分享页注入 cookie 后仍不是登录态。
【根因】分享页 SPA 启动时清理外来 localStorage token；登录态由 localStorage 的 `access_token` 主导，cookie 不足以恢复。
【修法/规避】注入恢复必须先过 SPA 启动时序，或改走「凭据串存本地 + 请求时带 Authorization」。
【教训】先确认登录态以谁主导（cookie 还是 localStorage），比「注入成功没有」更重要。

## 2026-09-08 缩略图 `security-token` 严格绑定 `op=t`

【现象】把缩略图 URL 的 `op` 换成别的值，一律 403。
【根因】`security-token` 与 `op` 在上游是签名绑定的，不是可复用凭据。
【修法/规避】不要外推到下载链路；下载走 `get_download_url` 的正规签名。
【教训】签名参数成套生效，改一个字段整串失效。

## 2026-09-08 转存 batch 漏 `x-share-token` → 内层 403

【现象】`POST /adrive/v4/batch` 返回 403，外层看像权限问题。
【根因】请求头缺 `x-share-token`（源分享授权）。转存要两个身份：`x-share-token`（源）+ `Authorization`（落盘账号）。
【修法/规避】补上头即 201 并回传新 `file_id`。
【教训】两跳链路里「这一步用的是谁的身份」最容易搞混，缺哪个给的就是内层 403。

## 2026-09-01 prase 大面积 400/23018：双重取号 + 假游客

【现象】launcher 链路 prase 大量 400（夸克 23018），数据看板明细空；单独跑 wrangler + 完整 cookie 却 200。
【根因】三层叠加：① `backend/launcher.sh` 被改，强制给本地 wrangler 写 `BACKEND_URL` → functions 也去 cookie-pick 取号，与 hop 的账号注入**双重取号**；② `backend/src/proxy.js` cookie-pick 取不到号时自动创建随机 `__pugs` guest，夸克大文件不认；③ guest 落库污染账号池，还回 200 假象，掩盖「没有可用账号」。
【修法/规避】保证一条请求只有一个取号方；guest 自动创建按网盘区分（夸克不自动建，返回 `NO_ACCOUNT` + 明确文案）。
【教训】「200 但结果是假的」比 500 更难查；凡是能自动兜底的地方，都要能被一条日志看见。

## 2026-08-30 hop 401：两个位置各存了一份 PROXY_TOKEN

【现象】scan 稳定 401 `UNAUTHORIZED / X-Proxy-Token 无效`，但 hop 侧校验是过的。
【根因】**token 漂移**：wrangler 的 `env.PROXY_TOKEN` ≠ `config.json` 里的 `proxy.token`。面板轮换只写 config.json 不写 `.dev.vars`；或 wrangler 先启动、attach 模式握着旧 token。
【修法/规避】轮换时同步写 `.dev.vars`（`syncDevVars`）；attach 前确认 inspector 端口属于本次实例。
【教训】同一个密钥存两处就迟早不一致；「hop 说通过、wrangler 说 401」先查密钥是否同源。

## 2026-08-30 hop 转发三处隐坑（gzip 头 / set-cookie 死代码 / 刷新端点 404）

【现象】三个互不相干的症状先后冒出：浏览器解压失败（`incorrect header check`）、`__puus` 刷新不生效、账号每 2h 被误标 fail。
【根因】① undici 自动解压 body，但 `content-encoding: gzip` 头原样透传（hop-by-hop 头没剥）；② wrangler 的 proxy.js 不回原始 `set-cookie`，只回 `x-quark-pus/__puus` 提取头 → `backend/src/proxy.js` 里读 `set-cookie` 的合并逻辑是死代码；③ 刷新端点用的是 404 的 `drive-h.quark.cn/1/clouddrive/account/info`（正确是 `pan.quark.cn/account/info`）。
【修法/规避】剥 hop-by-hop 头；set-cookie 合并改从回传头取补丁；换正确刷新端点（`backend/src/cookies.js`）。
【教训】透传代理要显式声明「哪些头不过境」；「写了但从不进」的分支等同于没有。

## 2026-08-28 `wrangler pages dev` 默认绑 0.0.0.0，把源码树暴露到局域网

【现象】开发机在局域网里，别人的 `http://<内网IP>:端口` 能直接看到源码树。
【根因】`wrangler pages dev` 默认监听 `0.0.0.0`；launcher 早期没显式指定 ip。
【修法/规避】launcher 强制 `--ip 127.0.0.1`；局域网共享需显式 `PANHUB_BIND=0.0.0.0`（旧名 `PANHUB_IP`，风险自担）。
【后续】2026-08-30 拍板把默认值反转为 `0.0.0.0`（企业内网形态），此时 webui 仍限固定内网 IP——按部署形态选，别照抄。
【教训】「本机开发」和「内网共享」是两个威胁模型；默认值必须写死，不能靠工具默认。

## 2026-08-27 夸克 <50MB 直链拿得到却下不了

【现象】小文件 prase 200 + 有直链，导出后下载中断。
【根因】用户填过登录态整串后，小文件请求也带完整 cookie → 上游回登录态 CDN 直链（`dl-pc-zb`），但小文件分支只配 `__pugs` → 凭据与直链不匹配，文件流被掐断（三种请求姿势本身都 200）。
【修法/规避】凭据绑定改成「响应驱动、与 size 无关」：直链认哪套签名就配哪套（`__puus` → `__pugs`）。
【教训】「200 却不给数据」优先怀疑凭据与 CDN 域名不配套，而不是网络。

## 2026-08-27 sed 批量替换误伤 mock 里的真实字段名

【现象】把 `md5` 统一改名 `hash` 的 sed 顺手改掉了测试 mock 里的真实上游字段 `item.md5`，测试假失败。
【根因】批量替换不区分「我方变量名」和「上游原始字段名」。
【修法/规避】重写测试比 sed 安全；必须 sed 时限定文件范围并逐条 review。
【教训】重命名类改动里，mock 数据要当外文处理——它是照抄上游的。

## 2026-08-23 `share_fid_token` / `__pugs` 与直链同响应绑定

【现象】直链单独存下来再下，403 `ucidMd5 invalid`（379B XML）。
【根因】解析凭据与直链在**同一次响应内**签发，跨响应/跨环境混用必然不匹配。
【修法/规避】按文件注入各自响应拿到的 cookie（`DownloadResult` / `LinkResult` / `ExportFile.cookie`）。
【教训】这类凭据是「配对使用」的，缓存复用时必须整对缓存。

## 2026-08-14 GitHub 拒推：祖先链里有 192MB 大文件

【现象】push 被拒（超体积限制）。
【根因】历史 commit 提交过 `restore_pkg`（192MB）；当前 tag 树里没有，但祖先链里有，GitHub 仍然算。
【修法/规避】`filter-branch` 重写历史（20 个 commit 全重写，tag 自动跟随）后推送成功。
【教训】「现在没有」不等于「历史没有」；大文件要在提交前拦，提交后只能改史。

## 2026-08-11 UC 直链游客拿得到、下不了

【现象】API 层成功返回直链，下载层 403。
【根因】OSS 回调要求登录（`require login`）——平台业务限制，不是签名/参数问题。
【修法/规避】别在这条线上继续试参数；要么走登录态账号池，要么接受该限制。
【教训】区分「技术可绕过」和「平台不开门」，后者别浪费工时。
