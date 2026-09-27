/**
 * Cloudflare Pages Function —— /api/guestbook（公开接口）
 *
 * Pages 把 functions/ 目录按文件路径映射成路由，这个文件即 /api/guestbook。
 * 这条路径上只有三件事：
 *   - GET             读公开留言列表
 *   - GET ?whoami=1   看自己会被分配成什么昵称
 *   - POST            写一条公开留言，或私信站主
 *
 * **管理能力不在这个文件里**：这里不传 adminToken，所以「读私信」（?scope=all）
 * 与「删留言」（DELETE）在这条路径上恒为 403。管理操作走 /api/admin/guestbook。
 *
 * 这么拆的用意是让公开入口的攻击面里**根本不存在「删」这个动作** ——
 * 不去赌口令够不够强，而是那条路上没有门。
 *
 * 存储与配置装配见 src/lib/guestbook-kv.ts，业务逻辑见 src/lib/guestbook-core.ts。
 */

import { handleGuestbook } from '../../src/lib/guestbook-core';
import { createGuestbookStore, publicOptions, type Env } from '../../src/lib/guestbook-kv';

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> =>
  handleGuestbook(context.request, createGuestbookStore(context.env), publicOptions(context.env));
