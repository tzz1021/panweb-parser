## 1.迅雷cdn获取接口的参数写法参考云析

https://github.com/CYQawa/YunX/blob/700ce1269924cfef4cf9b5a54db47482a1b79148/app/src/main/kotlin/com/yunx/app/data/network/XunleiApi.kt#L425

L431
```
        val url = "${XunleiConstants.FILES_URL}/$fileId?_magic=2021&usage=PLAY&thumbnail_size=SIZE_LARGE" +
            "&with=hdr10&with=subtitle_files&with=task&with=public_share_tag"
```

详细上下文：[xunlei-dl-choices.md](./xunlei-dl-choices.md)
