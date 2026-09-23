# 个人站点骨架：图片 · 文字 · 动效 · 声音

一个**纯静态 + 边缘函数**的个人网站起点，为「国内 IP 能直接打开」这个目标做了取舍：
默认主线是 Cloudflare Pages / Workers（免费），并预留一条**不备案也能国内直连**的备用出口。

> ⚠️ 先明确一件事：**Cloudflare 免费版无法保证中国大陆 100% 可达**。
> 原因、量化对比、缓解与验收方法都写在 [`docs/技术路线.md`](docs/技术路线.md)，建议先读它。

---

## 快速开始

```bash
npm install
npm run gen:assets     # 生成演示图片与音频（CC0，程序合成）
npm run dev            # http://localhost:4321
```

本地要连**函数**一起调试（`/api/visit` 访客计数）：

```bash
# 用 Cloudflare 的本地运行时（含 Pages Functions + KV 模拟）
npx wrangler pages dev ./dist --kv VISITS
# 或者用零依赖的 Node 出口
npm run build && npm run serve:node   # http://localhost:8080
```

## 目录结构

```text
personal-site/
├─ src/
│  ├─ assets/generated/     程序生成的示例图（会被构建期转成 AVIF/WebP）
│  ├─ components/           Hero(WebGL) / ScrollStory(GSAP) / AudioPlayer(Web Audio)
│  ├─ content/notes/*.md    文章内容（schema 校验，改文字不用碰代码）
│  ├─ content.config.ts     内容集合定义
│  ├─ layouts/BaseLayout.astro
│  ├─ lib/visit-core.ts     ★ 与平台无关的计数逻辑（CF 与 Node 共用）
│  ├─ pages/                首页 / 笔记列表 / 笔记详情 / 404
│  ├─ scripts/              webgl-hero / scroll-story / audio-player（全部动态 import）
│  └─ styles/global.css     设计令牌 + 全局排版 + 降级规则
├─ functions/api/visit.ts   ★ Cloudflare Pages Function（KV 存储）
├─ server/index.mjs         ★ 备用出口：Node 静态服务 + Range + 同一个 API
├─ public/
│  ├─ _headers              Cloudflare 缓存与安全响应头
│  └─ audio/demo.wav        示例音频（换成你的 mp3/opus）
├─ scripts/gen-demo-assets.mjs
├─ wrangler.toml            Pages 项目 + KV 绑定
├─ edgeone.json.example     EdgeOne Pages 备用出口示例（第三条出口，可选）
└─ docs/
   ├─ 上线手册-路线A.md     逐步上线手册（当前采用：纯 Cloudflare）
   ├─ 技术路线.md           可达性方案、DNS 拓扑、验收、成本与风险
   └─ 拨测记录.md           多线路拨测基线记录模板
```

## 关键实现约定

| 关注点 | 做法 | 为什么 |
| --- | --- | --- |
| 首屏体积 | 无外部字体、无第三方脚本、CSS 内联 | 国内访问境外节点时，弱网下每 KB 都要命 |
| 动效 | `three` / `gsap` 全部动态 `import()` | 动效库不进首屏关键路径 |
| 降级 | `prefers-reduced-motion` 下连动效库都不下载 | 无障碍与弱网是同一个问题 |
| 图片 | 构建期 AVIF + 多尺寸 + lazy | 源图 1600px 也能压到几十 KB |
| 音频 | `preload="none"`，点击才加载 | 不点播放就一个字节不下；Pages 不返回 206，音频文件要控制体积 |
| 函数 | 标准 `fetch` handler，KV 通过接口注入 | 换托管方（CF ↔ Node）业务代码零改动 |
| 缓存 | hash 资源 `immutable` 一年，HTML 不缓存 | 改版即时生效，静态资源拉满缓存 |

## 上线步骤（路线 A：纯 Cloudflare，不备案）

**完整逐步操作见 [`docs/上线手册-路线A.md`](docs/上线手册-路线A.md)**，这里只列顺序：

1. **域名接入 Cloudflare**：Add a site → 把注册商的 NS 换成 Cloudflare 分配的两个，等状态 Active
2. **建 KV 并填 ID**：`npm run kv:create`，把输出的 `id` 写进 `wrangler.toml`
   （不配也能跑，退化为内存计数；但别留占位符 ID，会部署失败）
3. **建 Pages 项目**：Git 集成（构建命令 `npm run build`、输出 `dist`、环境变量 `NODE_VERSION=22`）
   或本地 `npm run deploy:cf` 直推
4. **绑自定义域名**：apex `example.com` 直接绑；`www` 用 Bulk Redirects 做 301 到 apex。
   **不要用 `*.pages.dev` 当正式入口**，该域名在国内被污染/阻断的概率明显更高
5. **自检 + 拨测**：按手册第 7 步逐项核对，第 8 步用 itdog 拨测并把基线记进
   [`docs/拨测记录.md`](docs/拨测记录.md)
6. **可选**：`.github/workflows/deploy.yml` 提供 CI 双平台部署；香港出口需 `vars.ENABLE_VPS=true`
   才启用，**路线 A 不需要**

## 换成你自己的内容

```bash
# 图片：替换 src/assets/generated/ 下的 PNG，或直接换成你的 jpg/avif
# 音频：把文件放进 public/audio/，改 src/components/AudioPlayer.astro 里的 src
# 文字：在 src/content/notes/ 新建 .md，字段见 src/content.config.ts
```

`npm run gen:assets` 只会覆盖示例素材，随时可以删掉这个脚本和生成物。

## 性能预算（改动前先看这个）

| 指标 | 目标 |
| --- | --- |
| 首屏 HTML + CSS + JS（br） | ≤ 300 KB |
| LCP（Slow 4G + 4× CPU 降速） | ≤ 2.5 s |
| 首屏图片总量 | ≤ 1 MB |
| 单张图片 | ≤ 200 KB |
| 任何动效库 | 必须懒加载 |

实测方式：DevTools → Network → **Slow 4G** + Performance → **CPU 4× slowdown**，刷新后再看 LCP。

## 故障排除

| 现象 | 原因与处理 |
| --- | --- |
| `npm install` 报 `EPERM ... ~/.npm` | npm 全局缓存目录属主不对（以前用 sudo 装过包）：<br>`sudo chown -R "$(id -u):$(id -g)" ~/.npm`，或临时 `npm install --cache ./.npm-cache` |
| `wrangler` 报 `EPERM ... ~/Library/Preferences/.wrangler` | 同一类权限问题：修正该目录属主，或给 wrangler 指定可写的 `HOME` |
| 本地预览看不到访客数字 | `npm run preview` 只是静态服务，不含函数；改用 `npm run serve:node`（8080）或 `npx wrangler pages dev ./dist --kv VISITS` |
| 构建报 "chunk larger than 500 kB" | 是 three.js 的分包，属预期；它是懒加载的，不影响首屏 |

