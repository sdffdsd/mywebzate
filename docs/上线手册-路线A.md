# 上线手册 · 路线 A（纯 Cloudflare，不备案）

> 目标形态：`https://example.com` 为规范入口（apex 绑 Pages），`www` 301 跳到 apex。
> 全程只需要一个 Cloudflare 账号 + 一个域名，**月成本 ¥0**。
> 预计操作时间：约 40 分钟；DNS 生效等待 5 分钟 – 24 小时。

把文中 `example.com` 换成你自己的域名，`personal-site` 换成你想用的项目名。

---

## 当前进度（已完成的不用再做）

| 项 | 状态 |
| --- | --- |
| 步骤 1 域名 | ✅ `za4ever.com` 已注册，NS 已指向 Cloudflare（janet/toby），zone **active**（Free 套餐）<br>zone id `c57ffacb2430d70b227a140100f001f4` |
| DNS 记录 | ✅ `za4ever.com` 与 `www` 两条 CNAME 已创建（橙云代理），权威解析已生效 |
| 代码仓库 | ✅ 已推送到 https://github.com/sdffdsd/mywebzate（公开） |
| 步骤 2 KV | ✅ 命名空间 `VISITS` 已创建并绑定（id `6636d926f3164259bb5955623a736a32`） |
| 步骤 3 Pages 项目 | ✅ 项目 `personal-site` 已创建，已通过 `wrangler pages deploy` 部署成功 |
| 步骤 4 绑域名 | ✅ apex 状态 **active**，边缘证书已签发（Google Trust Services，`CN=za4ever.com`）<br>`www.za4ever.com` 也已绑定到同一个 Pages 项目 |
| 步骤 6 HTTPS | ✅ Always Use HTTPS = on；最低 TLS = 1.2；SSL 模式 = full |
| 正式地址 | **https://za4ever.com**（`http://` 会 301 到 `https://`） |
| 临时地址 | https://personal-site-btm.pages.dev（保留作为技术入口，别对外宣传） |
| 步骤 5 `www` 301 | ⬜ **未完成**：手头的 API Token 缺 `Zone → Config Rules → Edit` 权限，Redirect Rule 建不了 |
| 步骤 7 自检 | ✅ 页面/404/API/KV/缓存头 均已实测通过；Range 见下方"已知限制" |
| 步骤 8 拨测 | 🟡 已有一条真实数据点（你这条网络直连 Cloudflare）：TCP 145ms / TLS 300ms / TTFB 0.50–0.67s；多线路 itdog 拨测待做 |
| 待办（可选） | 在 Cloudflare 控制台把 Pages 项目连上 GitHub 仓库，实现"推送即部署"；现在改动后需手动跑 `npm run deploy:cf` |

**权限分工说明**：`wrangler` 的 OAuth 凭据只有 `pages:write` / `workers_*` / `zone:read`，
改不了 DNS 与 zone 设置；为此单独建了一枚 API Token（仅 Zone 级权限）用来写 DNS 与 HTTPS 设置。
该 Token 缺 `Zone → Config Rules → Edit`，所以 `www` 的 Redirect Rule 还建不了。

**已创建的 DNS 记录**（无需再手动添加）：

| 类型 | 名称 | 目标 | 代理 |
| --- | --- | --- | --- |
| CNAME | `za4ever.com` | `personal-site-btm.pages.dev` | 已代理（橙云） |
| CNAME | `www` | `za4ever.com` | 已代理（橙云） |

> ⚠️ 因为 `www` 已经作为自定义域名绑定到 Pages，它现在会**直接打开站点**而不是跳转。
> 想让 `www` 变成 301 跳转到 apex，二选一：

- **做法 A（推荐，与官方文档一致，零额外基础设施）**：给 API Token 补上
  `Zone → Config Rules → Edit` 权限，然后跑一次
  `PUT /zones/{zone_id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`：
  ```json
  {"rules":[{"action":"redirect","description":"www to apex 301",
    "expression":"(http.host eq \"www.za4ever.com\")",
    "action_parameters":{"from_value":{"status_code":301,
      "target_url":{"expression":"concat(\"https://za4ever.com\", http.request.uri.path)"},
      "preserve_query_string":true}}}]}
  ```
  或在控制台 **Rules → Redirect Rules → Create rule** 手点同样的内容。
- **做法 B（不需要额外权限）**：用 Workers 路由接管 `www.za4ever.com/*` 返回 301。
  wrangler 凭据里有 `workers_routes:write`，可以完全脚本化，代价是账户里多一个 Worker。

**已知限制（实测）**：Cloudflare Pages 对 `Range` 请求返回 `200` 完整文件而非 `206`，
所以音频文件要控制体积（几 MB 内），需要真流式播放请放 R2 或自有服务器。

---

## 进度总览

| # | 步骤 | 耗时 | 卡点 |
| --- | --- | --- | --- |
| 1 | 域名接入 Cloudflare（zone + 改 NS） | 10 分钟 + 等待生效 | NS 生效最长 24h |
| 2 | 创建 KV 命名空间并填 ID ✅ | 3 分钟 | 不填则计数不持久（不阻塞上线） |
| 3 | 创建 Pages 项目 ✅（Git 集成或本地直传） | 10 分钟 | 需要 GitHub 仓库 |
| 4 | 绑定 apex 自定义域名 | 5 分钟 | 证书签发最长 15 分钟 |
| 5 | `www` → apex 301 | 5 分钟 | 需要 Bulk Redirects |
| 6 | SSL / 安全设置 | 5 分钟 | HSTS 最后再开 |
| 7 | 部署后自检 | 5 分钟 | 见检查清单 |
| 8 | 国内可达性拨测 | 15 分钟 | 留基线，用于日后对比 |

---

## 步骤 1：域名接入 Cloudflare

> **省事提示**：如果域名直接在 [Cloudflare Registrar](https://dash.cloudflare.com/?to=/:account/domains/registrar) 注册，
> zone 已自动创建，可跳过改 NS 的等待。

1. 登录 Cloudflare → **Add a site** → 输入 `example.com` → 选 **Free** 套餐
2. Cloudflare 会扫描现有 DNS 记录。**只保留你需要的**（通常全删也没关系，后面第 4 步会自动创建）
3. 记下它分配的两个 nameserver，例如：
   ```
   arya.ns.cloudflare.com
   sam.ns.cloudflare.com
   ```
4. 到你的注册商后台 → 域名管理 → **修改 DNS 服务器**→ 换成上面两个
5. 回到 Cloudflare 概览页等状态从 *Pending* 变成 **Active**（通常 5–30 分钟，最长 24 小时）

验证：

```bash
dig NS example.com +short
# 应输出 arya.ns.cloudflare.com / sam.ns.cloudflare.com
```

---

## 步骤 2：创建 KV 命名空间

```bash
cd personal-site
npx wrangler login          # 浏览器授权一次
npx wrangler kv namespace create VISITS
```

输出里会有 `id = "xxxxxxxxxxxxxxxx"`，把它填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "VISITS"
id = "把这里替换成刚拿到的 id"
```

> ⚠️ **两个必须知道的点**
> 1. 仓库里一旦存在 `wrangler.toml`，它就是这个 Pages 项目的**唯一事实来源**——控制台里对应的字段会变成只读，
>    以后改绑定要改文件再部署（[官方说明](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)）。
>    如果你已经在控制台配过设置，先用 `npx wrangler pages download config <项目名>` 把现有配置拉下来。
> 2. **不想配 KV 也行**：把整个 `[[kv_namespaces]]` 段删掉，`/api/visit` 会退化成单实例内存计数
>    （网站功能完全正常，只是页脚数字会归零）。别保留占位符 ID，那会导致部署报错。

---

## 步骤 3：创建 Pages 项目

### 方式一：Git 集成（推荐，推代码即自动部署）

```bash
# ⚠️ 用绝对路径进项目目录。不要在主目录 ~ 里执行这些命令，
#    否则 git 会把整个用户主目录当成仓库（见文末「常见报错对照」）。
cd "/Users/zakura/Documents/dsh working/personal-site"

git init -b main
git config user.name  "你的名字"
git config user.email "你的邮箱"
git add -A
git commit -m "feat: 个人站点骨架"

# 先在 GitHub 网页建一个空仓库（不要勾选 README / .gitignore），然后：
# 把下面的 用户名 和 仓库名 换成真实值 —— 占位符不要带尖括号！
# 用 HTTPS 而不是 SSH：你机器上走的是本地代理，SSH 默认不吃 http_proxy。
git remote add origin https://github.com/用户名/仓库名.git
git push -u origin main
```

> **占位符不要写尖括号**：`<你的账号>` 里的 `<` `>` 会被 zsh 当作输入/输出重定向，
> 直接报 `zsh: no such file or directory`，命令根本不会执行（本文档其他位置的 `<...>` 同理）。

然后在 Cloudflare：

1. **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 选该仓库
2. 构建配置：
   - Build command：`npm run build`
   - Build output directory：`dist`
   - 环境变量：`NODE_VERSION` = `22`（本项目要求 Node ≥ 22.12，务必设）
3. 保存并部署，首次构建约 1–2 分钟，成功后拿到 `https://<项目名>.pages.dev`

> 如果控制台里输出目录是灰的，说明已由 `wrangler.toml` 的 `pages_build_output_dir` 提供，不用再填。

### 方式二：本地直传（不接 Git）

```bash
npx wrangler login
npm run build
npx wrangler pages deploy dist --project-name personal-site
```

直传方式每次改内容都要手动跑一次，适合先试水。

---

## 步骤 4：绑定 apex 自定义域名

1. Pages 项目 → **Custom domains** → **Set up a domain**
2. 输入 `example.com`（apex，不带 www）→ Continue
3. 因为域名已是本账号的 zone，Cloudflare 会自动创建 CNAME 记录并申请证书，**不需要你手改 DNS**
4. 等到域名状态变为 **Active**（证书通常几分钟，最长 15 分钟）

绑定后立刻验证：

```bash
curl -I https://example.com/
# 期望：HTTP/2 200
```

> `*.pages.dev` 保留作为技术入口，但**不要对外宣传它**——该域名在国内被污染/阻断的概率明显更高。

---

## 步骤 5：`www` → apex 301

按 Cloudflare 官方做法（[文档](https://developers.cloudflare.com/pages/how-to/www-redirect/)）：

1. 账号级 **Bulk Redirects** → 新建列表：

   | Source URL | Target URL | Status | Parameters |
   | --- | --- | --- | --- |
   | `www.example.com` | `https://example.com` | `301` | 勾选 Preserve query string / Subpath matching / Preserve path suffix |

2. 用该列表创建一条 **Bulk Redirect Rule**
3. 到 **DNS** → 给 `www` 加记录：类型 `A`、名称 `www`、IPv4 `192.0.2.1`、**代理状态：已代理（橙云）**

验证：

```bash
curl -I https://www.example.com/
# 期望：301，且 location: https://example.com/
```

> 更省事的替代：把 `www` 也绑成 Pages 自定义域名（两个域名都能开），
> 页面里已有 canonical 标签指向 `site` 配置的域名。代价是 SEO 上算重复内容，不推荐长期这样。

---

## 步骤 6：SSL 与安全设置

| 位置 | 设置 | 值 |
| --- | --- | --- |
| SSL/TLS → Overview | Encryption mode | **Full (strict)** |
| SSL/TLS → Edge Certificates | 证书状态 | `example.com` / `www` 均 Active |
| 同上 | Always Use HTTPS | **开** |
| 同上 | Minimum TLS Version | TLS 1.2 |
| 同上 | TLS 1.3 / Opportunistic Encryption | 保持默认开 |
| 同上 | HSTS | **确认全站 HTTPS 正常后再开**（开启后浏览器强制 HTTPS，回退麻烦） |
| Speed → Optimization | Brotli | 开（默认） |
| Security → Settings | Security Level | Medium（**不要**开 Under Attack，会误伤正常访客） |
| （可选）Web Analytics | 开启 | 免费、无 Cookie，可替代第三方统计 |

---

## 步骤 7：部署后自检清单

- [ ] 首页 / `/notes` / `/notes/why-static/` / 任意不存在的路径（应出 404 页面）都能正常访问
- [ ] `/api/visit` 返回 JSON：`curl https://example.com/api/visit`
- [ ] 页脚「本站访客」显示数字（说明 Function 与 KV 都通了）
- [ ] 立刻刷新一次，数字**不再 +1**（同 IP 30 秒节流生效）
- [ ] 静态资源缓存正确：
      `curl -I https://example.com/_astro/<任意带 hash 的文件>` → `cache-control: public, max-age=31536000, immutable`
- [ ] HTML 不缓存：`curl -I https://example.com/` → `cache-control: public, max-age=0, must-revalidate`
- [ ] 音频可播放（点击后有声音、频谱在动）：
      `curl -I https://example.com/audio/demo.wav` → `200` + `cache-control: public, max-age=604800`
- [ ] 已知限制：Cloudflare Pages 对 `Range` 请求返回 **200 完整文件**而不是 206（实测三种资源都如此），
      所以音频要控制体积；需要真正的流式拖动就把音频放到 R2 或自有服务器
- [ ] DevTools（Network: Slow 4G，Performance: CPU 4× 降速）刷新，**LCP < 2.5s**
- [ ] 手机实测：微信内打开、Safari、Chrome 各一次

---

## 步骤 8：国内可达性拨测（必须做，留基线）

1. 打开 [itdog.cn](https://www.itdog.cn/) 的「网站测速（HTTP）」→ 输入 `https://example.com`
2. 选 **移动 / 联通 / 电信 × 华东 / 华南 / 华北 / 西南**，至少 12 个测点
3. 结果记进 [`拨测记录.md`](拨测记录.md)（模板已备好）
4. 分别在**白天**和**晚高峰 20:00–23:00** 各测一次

判据：

| 指标 | 可接受 | 需要升级到路线 B |
| --- | --- | --- |
| 成功率 | ≥ 90% | < 90% |
| TTFB | < 1.5s | > 2.5s 或大量超时 |

---

## 可选：国内可达性缓解（灰色手段，谨慎）

只在你确认"当前表现不可接受、但又不打算备案"时再考虑：

- **档位 1（无风险）**：什么都不做，只把拨测做规律，等 Cloudflare 自身的入境质量波动。
  静态站已做过的优化（无外部字体、首屏 ~16KB、动效懒加载）此时就是最大收益。
- **档位 2（社区做法，风险自负）**：用 Cloudflare for SaaS 的 Custom Hostnames 功能，
  把 `cf.example.com` 指向社区维护的「优选 CNAME」，让国内访客命中更优的入境 IP。
  风险：随时失效、非官方支持路径、可能触碰 ToS；**绝不能**作为唯一入口
  （参考 [FaaS-in-China](https://github.com/jemerci/pages_speedup-FaaS-in-China) 的原理说明）。
- **如果最终要求"国内接近 100%"**：唯一可靠路径是备案 + 境内节点，见 [`技术路线.md`](技术路线.md) 第 9 节。
  代码已为此做好迁移准备（纯静态产物 + 标准 fetch handler）。

---

## 常见报错对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `git add -A` 报 `'.openclaw/workspace/' does not have a commit checked out`，或列出了 `Library/`、`Downloads/` 等 | **命令跑在了主目录 `~` 里**，`git` 把整个用户主目录当成仓库 | `rm -rf ~/.git`（前提：`git -C ~ rev-list --all --count` 为 0），然后 `cd` 到项目绝对路径重新 `git init` |
| `zsh: no such file or directory: xxx` | 命令里的 `<占位符>` 被 shell 当成重定向 | 去掉尖括号，替换成真实值 |
| `error: src refspec main does not match any` | 还没有任何提交就 push（前面的 `git add` 失败过） | 先让 `git add -A` + `git commit` 成功，再 push |
| `git@github.com: Permission denied (publickey)` | 没有 SSH key，或 SSH 不走本地代理 | 改用 HTTPS + Personal Access Token，或给 SSH 配 `ProxyCommand` |
| 访问域名报 **522** | 手工加了指向 `pages.dev` 的 CNAME，但没先在 Pages 里关联该域名 | 先在 Custom domains 里添加并等待生效 |
| 页面全 **404**，根路径正常 | 构建输出目录填错 | 确认是 `dist` |
| 构建失败 `Node version` 相关 | 构建镜像 Node 版本过低 | 加环境变量 `NODE_VERSION=22` |
| `/api/visit` 返回 503 | KV 绑定 ID 写错或命名空间不存在 | 核对 `wrangler.toml` 里的 `id` |
| 页脚数字一直是 `—` | 未部署 Function 或 KV 未绑定 | 先直接访问 `/api/visit` 看返回 |
| 证书长时间 Pending | 域名的 CAA 记录限制 | 按[官方要求](https://developers.cloudflare.com/pages/configuration/custom-domains/)加 `letsencrypt.org` / `pki.goog` / `ssl.com` 的 CAA |
| 改了 DNS 后 `www` 不跳转 | Bulk Redirect 列表或规则未启用 | 检查列表状态与规则表达式 |
| 发布后内容没变 | HTML 被缓存 | 本项目 HTML 已是 `must-revalidate`，多为浏览器缓存，强刷一次 |

---

## 应急与回滚

- **单次发布回滚**：Pages → Deployments → 选中上一个正常版本 → **Rollback**
- **整站应急入口**：给 `cf.example.com` 绑一份同样的 Pages 项目（或另一个账号的 Pages），
  出问题时改一条 DNS 就能把访客引过去
- **域名安全**：确认转移锁（clientTransferProhibited）与账号 MFA 已开启

---

## 上线后每周运维（5 分钟）

- [ ] 拨测一次，记录到 `拨测记录.md`
- [ ] Cloudflare 控制台看 Workers & Pages 的请求量与错误率
- [ ] 导出一次 KV 计数（可选）：`npx wrangler kv key get count --binding VISITS --remote`
- [ ] 检查证书剩余有效期
