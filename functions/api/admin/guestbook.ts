/**
 * Cloudflare Pages Function —— /api/admin/guestbook（管理接口）
 *
 * 只有当 `Authorization: Bearer <GUESTBOOK_ADMIN>` 校验通过时才会做任何事；
 * 失败一律 403，连读公开列表都不给（`requireAdmin`）。
 *
 * 三个操作（全部要求口令）：
 *   - GET              读公开列表（与公开接口同形）
 *   - GET ?scope=all   读全部留言：公开 + 私信，带指纹 / 地区 / 设备
 *   - DELETE ?id=<id>  删一条
 *
 * 口令只走请求头，**不接受 `?key=` 查询串** —— 查询串会进 Cloudflare 的请求
 * 日志、浏览器历史与 Referer，等于把删除权交给能看到日志的所有人。
 *
 * 建议再在前面加一层 Cloudflare Access（按你的身份放行），口令作为第二道锁：
 * *.pages.dev 那个备用域名不在 Access 的主机名范围内，那道锁是它的兜底。
 * 步骤见 docs/留言板-实现路径.md 的「权限」一节。
 */

import { handleGuestbook } from '../../../src/lib/guestbook-core';
import { adminOptions, createGuestbookStore, type Env } from '../../../src/lib/guestbook-kv';

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleGuestbook(context.request, createGuestbookStore(context.env), adminOptions(context.env));
