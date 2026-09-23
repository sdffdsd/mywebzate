/**
 * Cloudflare Pages Function —— /api/visit
 *
 * Pages 会把 functions/ 目录按文件路径映射成路由，这个文件即 /api/visit。
 * 绑定通过 wrangler.toml 的 [[kv_namespaces]] 注入（binding = "VISITS"）。
 *
 * 没配 KV 时退化成单实例内存计数：本地 `wrangler pages dev` 也能直接跑通。
 */

import { handleVisit, type VisitStore } from '../../src/lib/visit-core';

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  VISITS?: KVNamespaceLike;
}

// 仅在未绑定 KV 时使用（开发环境 / 忘记配 KV 的兜底）
const fallback = { count: 0 };

function createStore(env: Env): VisitStore {
  const kv = env.VISITS;

  if (!kv) {
    return {
      get: async () => fallback.count,
      set: async (value) => {
        fallback.count = value;
      },
    };
  }

  return {
    get: async () => {
      const raw = await kv.get('count');
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    },
    set: async (value) => {
      await kv.put('count', String(value));
    },
  };
}

export const onRequest = async (context: {
  request: Request;
  env: Env;
}): Promise<Response> => handleVisit(context.request, createStore(context.env));
