# 迅雷 web 端 captcha_sign：模块化签名与轮换（v1.4.2）

> 一句话：签名 = `1.` + 逐盐 md5 链；**官方约 20 天换一次盐**（只改盐值与个数，不改逻辑）。
> 代码：`backend/src/xunlei-sign.js`（唯一实现）+ `backend/src/xunlei.js`（live/manual 两种模式）。

## 1. 算法

```
h = client_id + client_version + package_name + device_id + timestamp(ms)
for (salt of salts) h = md5(h + salt)
captcha_sign = '1.' + h
```

- `package_name` / `client_version` **必须与生成 sign 时一致**（混搭 → `invalid captcha_sign`）；
  `test-pan` / `pre-pan` 域名会被归一化成 `pan.xunlei.com`。
- 调用：`POST https://xluser-ssl.xunlei.com/v1/shield/captcha/init`，`meta = {package_name, client_version, captcha_sign, timestamp, user_id}`。

## 2. 当前版本（2026-10）

| 项 | 值 |
|---|---|
| client_id | `Xqp0kJBXWhwaTpB6`（webapp 固定值） |
| client_version | **1.93.10** |
| package_name | `pan.xunlei.com` |
| 盐 | **9 条**（顺序敏感，见 `SIGN_PROFILE_DEFAULTS.salts`） |
| 自检向量 | `ts=1792243618981` + `device=550cfe136e9d74e95be5393738639de7` → `1.4181a24198c7edfbbba2afbcf1f4fab0`（`node -e` 调 `signSelfTest()` 应为 PASS） |

> linkswift L7430 那一版（8 盐，配 1.93.6）已失效：同一个 sign 配 `1.93.6` 会 **400 invalid captcha_sign**，
> 配 `1.93.10` 才 200（2026-10-18 真机实测）。

## 3. 两种模式

| 模式 | 行为 | 适用 |
|---|---|---|
| **live**（默认，推荐） | 每次请求**实时算** sign + timestamp，并用**同一个 profile** 的 `client_id/client_version/package_name` 组 meta → 天然不会「sign 与 meta 版本不配套」 | 后台托管（多账号） |
| **manual** | 用录入的 `(captcha_sign, captcha_timestamp)` 原样带；`client_id/client_version/package_name/device_id` 必须与 sign 配套 | 应急/回归旧值 |

- `device_id` 不是凭据，只是客户端标识：live 模式下缺省会**自动生成**并落库（`xunlei_device_id`），可手动重置。
- sign **没有时效校验**（7 天前的 timestamp+sign 依旧 200），token 本身 300s 过期；所以 token 按 action 缓存，剩余 >60s 复用。

## 4. 热加载与换盐流程（官方换 salt 时照做）

1. 面板 →「迅雷签名」→ 编辑 **sign profile**（`client_id / client_version / package_name / salts`）；
2. 点**自检**：显示 PASS/FAIL 与 got/want（FAIL 说明盐又变了，去抓新盐）；
3. 保存即生效（后端**每次调用重新读设置**，无需重启），并清空 token 缓存；
4. 副标题提示：**「大约 20 天官方换一次 salt，没法用了记得改这里；修改后热加载」**。

抓新盐的线索（与 linkswift 同源）：web 端 `service-captcha` + `utils-async` 打包里，
`qrImg/public-key` 链上那份 `SALTS` 数组（位置随版本变，搜 `captcha_sign` / `1.` + `md5` 链附近）。
拿到后按「值 + 顺序」整体替换，别只换个别值。

## 5. 常见报错

| 现象 | 原因 | 处理 |
|---|---|---|
| `400 invalid captcha_sign` | 盐过期，或 sign 与 `client_version/package/device` 不配套 | 先用自检；live 模式改 profile，manual 模式同步三件套 |
| `captcha_invalid`（业务侧） | token 缺失/过期 | 重新 init（缓存门槛 60s） |
| `401 unauthenticated` | restore/download 没带登录态 | 走账号段（backend 代发），不是 captcha 问题 |

## 6. 相关文件

- `backend/src/xunlei-sign.js`：profile 常量、`captchaSign()`、`normalizeSignProfile()`、`signSelfTest()`。
- `backend/src/xunlei.js`：`xunleiSignMode / xunleiSignProfile / xunleiSignProfileSelfTest / captchaTokenForAction`。
- `backend/src/server.js`：`GET/POST /api/web/xunlei/sign-profile`（POST 需二次确认令牌 + 热加载 + 清缓存 + 审计）。
- `docs/xunlei-dl-choices.md`：取链参数（CONSUME/PLAY）。
