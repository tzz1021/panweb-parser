# panweb-parser 🔧

> 网盘分享链接 → 目录树 → 批量直链 → 一键导出到 aria2 / Gopeed / cURL。
> 免安装、零上传、开源免费。把分享页变成你自己的下载器。

## 一句话定位

给linkswift加上更多可能性 meow~

## 隐私与安全承诺

- **无后端、无数据库**：怎么可能？在你本地罢了，这是CORS策略导致，被迫使用transport协议连接后端转发请求<**未涉及绕过IP限制，建议家庭使用or企业使用，不推荐购买远端服务器**>
- **不泄露你的 Cookie**：数据全支持，后端具有一键部署脚本，小白友好。一切足迹从未离开你的设备

## 掉包：理想与现实的平衡

- 阿里云盘与迅雷云盘强制要求转存
- 集体使用时“指定一个用户会主动寻找上次使用的阿里/迅雷账号，即子母号”设计减少转存次数降低风控，但是复用机制也有风险
- 在阿里云盘不同的分享share_id里，file_id只是这个分享内文件的唯一凭据。在多个分享中可能出现file_id一样但是文件不同。对于迅雷网盘公开分享的file_id就是分享者私有file_id，出现掉包概率极低，[这里](docs/reverse-notes-xunlei.md)提供进一步介绍
**策略**：及时删除转存后的所有内容（比如一天记为period）对于母号来言在一个period内只有初次解析时调用转存（发生在一个天赐子号用户身上），建议导出一份curl/gopeed任务保留sha1校验值（迅雷下载链接附带的HASH，是内部算法而非正常哈希请勿当做下载错误）。
对于个人下载完成后，请务必核对文件size是否一样，这样掉包概率可以再次下降


## 快速开始

1. 复制任意网盘（前提已经完成适配）分享链接
2. 打开体验[地址](https://panhub-praser.pages.dev) Tip：如果cloudflare太慢了那就本地部署呢
3. 输入复制好的分享链接，就会看到~~温馨的~~CORS弹窗，转到设置。代理输入体验地址，秘钥这个怎么可以随便发呢↓看看裙简介<可以不进裙丝毫不会介意>
4. 等一会真的就好了，找一个文件直接解析（prase）也可以快速筛选，页面功能有限自己摸索就好哦

## 功能

- 输入分享链接或整段分享文案（自动提取 URL 与提取码），自动识别网盘并高亮
- 目录树遍历
- 批量直链：15 个/批 + 1s 节流（LinkSwift 同款），失败可单独重试
- 直链有效期倒计时（OSS Expires 解析），过期一键重新获取
- 导出：aria2 命令 / input-file（保留目录结构）/ RPC JSON、Gopeed 任务 JSON、cURL 命令（不支持浏览器直接下载很抱歉，油猴和脚本猫使用了GM_xmlRequest）
- 连接本地下载器：配置 RPC 地址 / 密钥 / 保存路径
- 足迹系统（仅本地）：已填链接查重、目录树快照、解析记录、完整日志
- 偏好设置：UAC 表（转存/登录/限速）、大量冗余石山功能


## 技术栈

React 19 + TypeScript strict + Vite，零运行时依赖（无状态库/UI 库，AI？？？~~PIA~~设计）。

## Wiki · 自托管与代理指南

这里是胡写的别看了，到scripts找到selfhost.sh执行即可自动缓存必要后端文件同时告诉你后端一键管理脚本backend/launcher.sh
- [入口/方案对比](docs/wiki.md)（Cloudflare 白嫖 vs 自建服务端）
- [白嫖 Cloudflare（10 分钟，10 万请求/天）](docs/wiki-cloudflare.md)
- [自建服务端代理（Node 零依赖，数据全自持）](docs/wiki-selfhost.md)

## 指挥中心（backend + 管理面板，v1.2.2）

带多账号、cookie 自动刷新、可视化看板的自托管转发代理（设计稿 [docs/backend-wrangler-plan.md](docs/backend-wrangler-plan.md) v1.2.2 定稿）。
**SPA 不本地托管**：前端走 CF/GitHub CDN 加载(也可以本地。。)

### 全新机器两条命令（scripts/selfhost.sh 引导）

```bash
# 1) 拉取并运行自托管引导（交互选择：完整源码 / 管理端；codeload tarball 优先 + ghproxy 镜像兜底 + sha256 校验）
curl -fsSL https://raw.githubusercontent.com/tzz1021/panhub_praser/master/scripts/selfhost.sh -o selfhost.sh && bash selfhost.sh

# 2) 初始化并启动（自动生成端口 + 双令牌 + 根 .dev.vars）
cd ~/panhub_praser && ./backend/launcher.sh setup && ./backend/launcher.sh start
```

### 已有源码（clone / 管理端已就绪）

```bash
./backend/launcher.sh setup    # 首次：检测 node/wrangler → 装依赖 → 生成端口+双令牌 + .dev.vars
./backend/launcher.sh debug    # 首次排查：wrangler 真 TTY 交互面板（b/d/e/t/c/x）+ backend 后台日志（有 tmux 自动分窗）
./backend/launcher.sh start    # 日常后台启动（B 端局域网共享：PANHUB_BIND=0.0.0.0）
./backend/launcher.sh status / stop / restart / logs / backup / reset
```

详见 [backend/README.md](backend/README.md)。

## 反馈留言

这个bushi必备的，你可以直接提出issues，如果有好点子也欢迎PR
如果只是想白嫖我的服务只能使用UC哦
- 裙835890223<无内测通知，采集反馈与开发建议>
- 内测开发推送[频道](https://t.me/Water_molecule)置顶消息可以进入群组交流

## 参考与致谢

- 核心功能参考开源项目 [LinkSwift](https://github.com/hmjz100/LinkSwift)
- UI 部分参考 [pdpb.cn](https://pdpb.cn)（布局与配色）
- 功能方向参考 [nfd 云解析](https://github.com/qaiu/netdisk-fast-download)（自托管思路）
- 版权与迁移说明见 [docs/migration-linkswift.md](docs/migration-linkswift.md)

## License

[GPLv3](LICENSE) —— 完全开源免费，如果通过付费渠道获取到，请立即申请退款并差评。
