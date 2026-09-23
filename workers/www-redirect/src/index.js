/**
 * www.za4ever.com → https://za4ever.com 的 301 跳转
 *
 * 为什么用 Worker 而不是 Cloudflare 的 Redirect Rule：
 *   Redirect Rule 需要 API Token 具备 `Zone → Config Rules → Edit` 权限，
 *   而现有的 wrangler 凭据只有 `workers_routes:write` / `workers_scripts:write`。
 *   用 Worker 路由可以完全脚本化，不需要额外开权限。
 *   代价：账户里多一个 Worker（免费额度内，且只在 www 这个 hostname 上运行）。
 *
 * 如果以后想换成官方 Redirect Rule，删掉这个 Worker 与路由即可，
 * 请求体模板见 docs/上线手册-路线A.md。
 *
 * 部署：npm run deploy:www-redirect（等价于 cd workers/www-redirect && wrangler deploy）
 */

const APEX = 'https://za4ever.com';

export default {
  fetch(request) {
    const url = new URL(request.url);

    // 保留原始路径与查询串：/notes/?a=1 → https://za4ever.com/notes/?a=1
    const target = new URL(url.pathname + url.search, APEX);

    // 301 永久跳转；Response.redirect 会带上 location 头，且没有响应体
    return Response.redirect(target.toString(), 301);
  },
};
