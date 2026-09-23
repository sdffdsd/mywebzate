/**
 * 与平台无关的访客计数逻辑。
 *
 * 同一份代码同时被两处使用：
 *   1. functions/api/visit.ts —— Cloudflare Pages Functions（KV 绑定）
 *   2. server/index.mjs       —— 任意 Node 机器（JSON 文件落盘）
 *
 * 只依赖标准 Request/Response，不 import 任何平台 SDK，
 * 所以换托管方时业务代码零改动。
 */

export interface VisitStore {
  get(): Promise<number>;
  set(value: number): Promise<void>;
}

export interface VisitPayload {
  count: number;
  /** 本次请求是否真的写入了计数（机器人 / 无 inc 参数时为 false） */
  counted: boolean;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // 计数接口不能有任何中间层缓存
  'cache-control': 'no-store, must-revalidate',
};

const isBot = (userAgent: string | null): boolean =>
  !userAgent || /bot|crawler|spider|preview|headless|curl|wget|monitor/i.test(userAgent);

/** 单实例内的写入节流：同一 IP 30 秒内只累加一次，挡住手抖刷新与探测。 */
const THROTTLE_MS = 30_000;
const recent = new Map<string, number>();

function throttled(key: string): boolean {
  const now = Date.now();
  const last = recent.get(key);

  // 顺手清理，避免 isolate 长时间存活导致 Map 无限增长
  if (recent.size > 5000) {
    for (const [k, t] of recent) {
      if (now - t > THROTTLE_MS) recent.delete(k);
    }
  }

  if (last !== undefined && now - last < THROTTLE_MS) return true;
  recent.set(key, now);
  return false;
}

export async function handleVisit(request: Request, store: VisitStore): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } });
  }

  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: 'GET, POST, OPTIONS' },
    });
  }

  const url = new URL(request.url);
  const wantsIncrement = url.searchParams.get('inc') === '1';

  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';

  const shouldCount =
    wantsIncrement && !isBot(request.headers.get('user-agent')) && !throttled(ip);

  try {
    let count = await store.get();

    if (shouldCount) {
      count += 1;
      await store.set(count);
    }

    const payload: VisitPayload = { count, counted: shouldCount };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...JSON_HEADERS,
        // 方便你在浏览器里直接确认是否命中节流
        'x-counted': String(shouldCount),
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: 'store_unavailable', detail: String(error) }),
      { status: 503, headers: JSON_HEADERS },
    );
  }
}
