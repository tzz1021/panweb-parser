# 迅雷取链参数：CONSUME vs PLAY（借鉴了yunx的PLAY参数）

> 适用：`GET https://api-pan.xunlei.com/drive/v1/files/{id}?space=&usage=<CONSUME|PLAY>`
> 本项目默认 **CONSUME**；可在设置「最后一个接口参数」用规则按文件名切换（见文末）。

## 1. 四类链接

| 编号  | 来源                                            | 说明                                            |
| --- | --------------------------------------------- | --------------------------------------------- |
| ①   | `web_content_link`                            | 常规直链（两个 usage 都会给）                            |
| ②   | `links['application/octet-stream'].url`（PLAY） | **stream 直链**，可下载也可浏览器播放                      |
| ③   | `medias[].link.url`（PLAY，仅视频等）                | 分画质/分媒体直链（`media_name: 原始画质`），可下载也可播放；画质取决于账号 |
| ④   | `md5_checksum`（CONSUME，**概率**出现）              | 真实 md5，**可用来秒传**                              |

要点：
- ①②③ 都能下载、也能直接在浏览器播放；**服务器都不提供文件名**（无 `content-disposition`）→
  导出/保存必须用我们自己的路径名（与 `docs/reverse-notes-xunlei.md` §3.4 的 Range 实测一致）。
- **2026-10-18 实测修正：① 与 ② 在同一次请求里必定同时出现且内容完全一样**——不存在优劣（早前表里写「② > ①」是误解）；
  ③（若有）仍可能不同（分画质/分媒体）。
- **速度与高峰期强相关**：高峰约 1–2 MB/s，低谷一般 10 MB/s 以上（与接口/参数无关，别拿速度差异去归因参数）。
- 视频类还可能带 `params.duration/width/height` 与 `medias[].video{codec,bit_rate,frame_rate,hdr_type}`。

## 2. 触发与文件形态矩阵

行的「点击默认触发」= web 端点击文件时页面自己发的 usage；列按**服务器给出的后缀**划分（不等于真实文件类型）。

|             | 常规（安装包/办公等） | 压缩 `zip/rar/7z`（`tar.gz`/`tgz` 罕见） | 压缩包改/加数字后缀（`001`、`405` 等） | 压缩包去后缀      | 视频   | 其他改 `mp4/mov` | 罕见/无（已测 `ini`、真分卷） |
| ----------- | ----------- | ---------------------------------- | ------------------------- | ----------- | ---- | ------------- | ------------------ |
| 点击默认触发      | CONSUME     | decompress 接口                      | CONSUME                   | CONSUME     | PLAY | PLAY          | CONSUME            |
| **CONSUME** | ①②          | 不给任何有效信息                           | ①② & 概率 ④                 | ①②（真压缩概率 ④） | ③④   | ③             | ①②                 |
| **PLAY**    | ①②          | ①②                                 | ①②                        | ①②          | ①②③④ | ①②③           | ①②                 |

读法：
- **压缩类（zip/rar/7z）不改名时只能走 PLAY**：PLAY → ①② 正常返回；**CONSUME → 完全不给下载地址**
  （`web_content_link:""`、`links:{}`，只有 `apps[].decompress` 在线解压入口）→ 要么 rename，要么用 PLAY（2026-10-18 实测）。
- 压缩包改成 `001`/`405` 这类分卷后缀后，CONSUME 会正常给 ①②，**并有一定概率额外给 ④ 真实 md5**（可秒传）。
- 于是前端对压缩类给三个选项：**「原样（仅可 PLAY，不重命名）」/「加随机数后缀」/「抹去后缀」**；
  选「原样」时 usage 强制 PLAY；选后两者才 rename（rename 后 CONSUME 也能出链）。

## 3. 一次视频 PLAY 响应（关键字段，签名已省略）

```jsonc
{
  "kind": "drive#file", "id": "VOtyEet7bqhO9lFTDTd4EnuUA1", "name": "250815第3课python控制流语句.mp4",
  "size": "1031964586", "file_extension": ".mp4", "mime_type": "video/mp4", "file_category": "VIDEO",
  "web_content_link": "https://vod0001-…xunlei.com/download/?…&e=1791204766&…&fileid=…&at=…",   // ①
  "links": {
    "application/octet-stream": {
      "url": "https://vod0001-…xunlei.com/download/?…&e=1791204766&…",                          // ②（spr=flow）
      "token": "eyJ…", "expire": "2026-10-05T20:52:46.990+08:00", "token_type": "TOKEN_TYPE_ACCELERATION"
    }
  },
  "medias": [{
    "media_id": "3FD44D1E39C6D885C2309789E8EA2151039EA696", "media_name": "原始画质", "is_origin": true,
    "video": { "height": 1080, "width": 1920, "duration": 8473, "bit_rate": 777313, "frame_rate": 24,
               "video_codec": "h264", "audio_codec": "aac", "hdr_type": "" },
    "link": { "url": "https://vod0002-…xunlei.com/download/?…&e=1791204767&…&vc=h264&…",        // ③
              "expire": "2026-10-05T20:52:47.044+08:00", "token_type": "TOKEN_TYPE_ACCELERATION" }
  }],
  "md5_checksum": "AF352DAE48BB96607A1F0B9D182C5AB6",   // ④（真实 md5；CONSUME 下不保证出现）
  "hash": "3FD44D1E39C6D885C2309789E8EA2151039EA696",   // 内部标识（与 URL 的 g= 同值），非内容摘要
  "params": { "duration": "8473", "height": "1080", "width": "1920", "task_id": "…", "url_info_id": "…" }
}
```

## 4. 本项目的落地方式

1. **默认 CONSUME**；需要更快/视频场景时用 PLAY。
2. **设置 → 迅雷云盘 → 「最后一个接口参数」**（多行文本，每行一条规则，按文件名自上而下匹配，命中即用）：
   ```
   -regex ".*\.\(xls\|ppt\|docx\|pdf\)$" = CONSUME
   -iregex ".*\.\(ts\|mp4\|mov\)$" = PLAY
   ```
   - `-regex` 区分大小写，`-iregex` 不区分；右侧只认 `CONSUME` / `PLAY`；非法行忽略；无命中 → `CONSUME`。
3. **转存成功后弹窗**「选择取链方案，暂不支持云解压」：可选 `自动（按规则）` / `CONSUME` / `PLAY`，批量时只弹一次。
4. 压缩包（`zip/rar/7z`，未改后缀）本工具**不代做云解压**：要么按提示手动处理，要么在设置里把它筛成 CONSUME/PLAY
   后自行下载（改/加数字后缀是常见做法，且 CONSUME 下有机会额外拿到 ④ 以便秒传）。
## 借鉴说明（已同步到THIRD-PART.md）

https://github.com/CYQawa/YunX/blob/700ce1269924cfef4cf9b5a54db47482a1b79148/app/src/main/kotlin/com/yunx/app/data/network/XunleiApi.kt#L425

L431
```
        val url = "${XunleiConstants.FILES_URL}/$fileId?_magic=2021&usage=PLAY&thumbnail_size=SIZE_LARGE" +
            "&with=hdr10&with=subtitle_files&with=task&with=public_share_tag"
```