/**
 * Cloudflare Pages Function —— /api/guestbook
 *
 * Pages 把 functions/ 目录按文件路径映射成路由，这个文件即 /api/guestbook。
 * 全部业务逻辑在 src/lib/guestbook-core.ts，这里只做三件事：
 *   1. 把 KV 包成 GuestbookStore；
 *   2. 从环境变量读盐 / 推送地址 / 管理口令；
 *   3. 没配 KV 时退化成单实例内存存储，本地 `wrangler pages dev` 直接能跑。
 *
 * 环境变量（都不是必需的，缺了功能会降级或关闭，不会 500）：
 *   GUESTBOOK_SALT   派生访客指纹的盐。不配则用开发默认值 —— 上线前必须配，
 *                    换盐等于给所有访客重新分配昵称与指纹。
 *   GUESTBOOK_PUSH   私信推送地址（Bark / Server酱 / 任意收 JSON 的端点）。
 *                    不配则私信只落库，不回你手机。
 *   GUESTBOOK_EMAIL  收件邮箱（多个用逗号分隔）。配了它，私信会顺便发一封邮件。
 *   GUESTBOOK_EMAIL_FROM 发件人；不配则用 onboarding@resend.dev（Resend 的测试发件人）
 *   RESEND_API_KEY   Resend 的 key（resend.com，免费 3000 封/月）。配上就走邮件。
 *   GUESTBOOK_ADMIN  管理口令。带上 ?key=... 可读私信、可删留言。
 *
 * KV 绑定：wrangler.toml 里绑成 GUESTBOOK；若懒得再建一个命名空间，
 * 也可以直接复用现有的 VISITS 绑定（键前缀不冲突：gbp/ gbx/ gbidx/ gbcount/ gbrl）。
 */

import {
  handleGuestbook,
  type GuestbookEntry,
  type GuestbookStore,
  type MailerLike,
  type Visibility,
} from '../../src/lib/guestbook-core';

interface KVListResult {
  keys: { name: string }[];
}

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number }): Promise<KVListResult>;
}

interface Env {
  GUESTBOOK?: KVNamespaceLike;
  VISITS?: KVNamespaceLike;
  GUESTBOOK_SALT?: string;
  GUESTBOOK_PUSH?: string;
  GUESTBOOK_EMAIL?: string;
  GUESTBOOK_EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  /** 配了 Email Routing 的域名上可以绑 send_email，绑到这个名字就零第三方发信 */
  GUESTBOOK_MAILER?: MailerLike;
  GUESTBOOK_ADMIN?: string;
}

const PREFIX: Record<Visibility, string> = { public: 'gbp:', private: 'gbx:' };
const INDEX = 'gbidx:';
const COUNT = 'gbcount:';
const RATE = 'gbrl:';

/* 时间戳取反再补零：KV 的 list 按 key 升序，这样最新的留言排在最前。 */
const keyFor = (entry: GuestbookEntry): string =>
  `${PREFIX[entry.visibility]}${String(9999999999999 - Date.parse(entry.createdAt)).padStart(13, '0')}:${entry.id}`;

function createStore(kv: KVNamespaceLike): GuestbookStore {
  const read = async (key: string): Promise<GuestbookEntry | null> => {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as GuestbookEntry;
    } catch {
      return null;
    }
  };

  const store: GuestbookStore = {
    async list(visibility, limit) {
      const { keys } = await kv.list({ prefix: PREFIX[visibility], limit });
      const entries = await Promise.all(keys.map((k) => read(k.name)));
      return entries.filter((e): e is GuestbookEntry => e !== null);
    },

    async put(entry) {
      const key = keyFor(entry);
      await kv.put(key, JSON.stringify(entry));
      /* 反查表：删除时不用把整表列一遍 */
      await kv.put(`${INDEX}${entry.id}`, key);

      const counterKey = `${COUNT}${entry.visibility}`;
      const next = (await store.count(entry.visibility)) + 1;
      await kv.put(counterKey, String(next));
      return next;
    },

    async remove(id) {
      const entryKey = await kv.get(`${INDEX}${id}`);
      if (!entryKey) return false;

      const raw = await kv.get(entryKey);
      await kv.delete(entryKey);
      await kv.delete(`${INDEX}${id}`);

      if (raw) {
        try {
          const entry = JSON.parse(raw) as GuestbookEntry;
          const counterKey = `${COUNT}${entry.visibility}`;
          const next = Math.max(0, (await store.count(entry.visibility)) - 1);
          await kv.put(counterKey, String(next));
        } catch {
          /* 计数只是显示用，坏了不影响删除 */
        }
      }

      return true;
    },

    async count(visibility) {
      const raw = await kv.get(`${COUNT}${visibility}`);
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    },

    async allow(visitorId, windowSec) {
      /* KV 的 expirationTtl 下限是 60 秒，比窗口长；
         所以真正的时间判断放在值里，TTL 只负责事后自动清理。 */
      const key = `${RATE}${visitorId}`;
      const now = Date.now();
      const last = Number(await kv.get(key));

      if (Number.isFinite(last) && last > 0 && now - last < windowSec * 1000) return false;

      await kv.put(key, String(now), { expirationTtl: 60 });
      return true;
    },
  };

  return store;
}

/** 没绑 KV 时的兜底：单实例内存，重启即空。 */
function createMemoryStore(): GuestbookStore {
  const entries: GuestbookEntry[] = [];
  const rate = new Map<string, number>();

  const slice = (visibility: Visibility, limit: number) =>
    entries
      .filter((e) => e.visibility === visibility)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);

  return {
    list: async (visibility, limit) => slice(visibility, limit),
    put: async (entry) => {
      entries.push(entry);
      return entries.filter((e) => e.visibility === entry.visibility).length;
    },
    remove: async (id) => {
      const index = entries.findIndex((e) => e.id === id);
      if (index === -1) return false;
      entries.splice(index, 1);
      return true;
    },
    count: async (visibility) => entries.filter((e) => e.visibility === visibility).length,
    allow: async (visitorId, windowSec) => {
      const now = Date.now();
      const last = rate.get(visitorId);
      if (last !== undefined && now - last < windowSec * 1000) return false;
      rate.set(visitorId, now);
      return true;
    },
  };
}

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> => {
  const kv = context.env.GUESTBOOK ?? context.env.VISITS;
  const store = kv ? createStore(kv) : createMemoryStore();

  return handleGuestbook(context.request, store, {
    /* 开发默认盐：只为了让本地跑得通，上线务必用 GUESTBOOK_SALT 覆盖 */
    salt: context.env.GUESTBOOK_SALT ?? 'dev-salt-change-me',
    pushWebhook: context.env.GUESTBOOK_PUSH,
    emailTo: context.env.GUESTBOOK_EMAIL,
    emailFrom: context.env.GUESTBOOK_EMAIL_FROM,
    resendKey: context.env.RESEND_API_KEY,
    mailer: context.env.GUESTBOOK_MAILER,
    adminToken: context.env.GUESTBOOK_ADMIN,
  });
};
