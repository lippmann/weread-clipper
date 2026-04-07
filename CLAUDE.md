# 微信读书剪藏 Chrome 插件

将网页文章（新闻、博客等）一键发送到微信读书的 Chrome 扩展。

## 项目结构

```
weread-clipper/
├── manifest.json              # Chrome 扩展配置（Manifest V3）
├── content/
│   └── content.js             # 文章提取 + 图片预取（运行在网页上下文）
├── lib/
│   └── epub.js                # 纯 JS EPUB 生成器（无外部依赖）
├── background/
│   └── service_worker.js      # 上传逻辑 + 图片解码
└── popup/
    ├── popup.html / .js / .css  # 插件弹窗 UI
```

## 核心流程

1. 用户点击插件图标，popup 注入 content.js 到当前页面
2. content.js 提取文章正文（多策略选择器 + 噪音过滤）
3. content.js 在页面上下文抓取图片（自带 Referer，绕过 CDN 防盗链）
4. service_worker.js 解码图片数据，调用 epub.js 生成 EPUB 文件
5. 打开 weread.qq.com/web/upload，注入 EPUB 到 `<input type="file">`
6. 微信读书自己的 JS 接管上传（自动处理 COS 凭证、签名等）

## 关键设计决策

- **不调用微信读书私有 API**：上传接口有动态签名（X-Wrpa-0），无法伪造。改为注入文件到上传页，让官方 JS 处理。
- **图片在 content script 抓取**：service worker 抓图无 Referer，BBC/网易等 CDN 会拒绝。content script 请求自带页面 Referer。
- **懒加载兼容**：优先读 data-src / data-original 等属性，而非 img.src（可能是占位符）。
- **主色调**：微信读书蓝 #3D9BF0

## 开发注意事项

- 修改代码后须在 `chrome://extensions` 刷新插件，**并刷新测试页面**（content.js 不会自动更新已打开的标签页）
- `__wereadClipperInjected` 标记防止重复注入，测试新代码时须刷新页面
- 用户需先登录 weread.qq.com（插件依赖其 Cookie）
