/**
 * Pages Functions 侧的存储与配置装配。
 *
 * 放在 `src/lib/` 而不是 `functions/` 下：`functions/` 里每个文件都会被映射成一个
 * 路由，而这个模块只是被两个入口引用，不该自己成为一个接口。
 *
 * 两个入口共用这里的一切：
 *   - functions/api/guestbook.ts        公开接口（**没有**管理能力）
 *   - functions/api/admin/guestbook.ts  管理接口（要求口令）
 *
 * 环境变量（都不是必需的，缺了功能会降级或关闭，不会 500）：
 *   GUESTBOOK_SALT   派生访客指纹的盐。不配则用开发默认值 —— 上线前必须配，
 *                    换盐等于给所有访客重新分配昵称与指纹。
 *   GUESTBOOK_PUSH   私信推送地址（Bark / Server酱 / 任意收 JSON 的端点）。
 *   GUESTBOOK_EMAIL  收件邮箱（多个用逗号分隔）。配了它，私信会顺便发一封邮件。
 *   GUESTBOOK_EMAIL_FROM 发件人；不配则用 onboarding@resend.dev（Resend 的测试发件人）
 *   RESEND_API_KEY   Resend 的 key（resend.com，免费 3000 封/月）。配上就走邮件。
 *   GUESTBOOK_ADMIN  管理口令。**只经 `Authorization: Bearer` 头传入**，
 *                    不接受 URL 查询串（会进日志）。仅 /api/admin/* 认它。
 *   GUESTBOOK_DM_COOLDOWN 给站主留言的冷却秒数（默认 300，即 5 分钟）。设 0 关闭。
 *
 * KV 绑定：wrangler.toml 里绑成 GUESTBOOK；若懒得再建一个命名空间，
 * 也可以直接复用现有的 VISITS 绑定（键前缀不冲突：gbp/ gbx/ gbidx/ gbcount/ gbrl）。
 */

import {
  parseCooldownSec,
  type GuestbookEntry,
  type GuestbookOptions,
  type GuestbookStore,
  type MailerLike,
  type Visibility,
} from './guestbook-core';

interface KVListResult {
  keys: { name: string }[];
}

interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number }): Promise<KVListResult>;
}

export interface Env {
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
  /** 给站主留言（私信）的冷却秒数；不配则用核心默认的 300 秒 */
  GUESTBOOK_DM_COOLDOWN?: string;
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

    async claim(visitorId, windowSec) {
      const key = `${RATE}${visitorId}`;
      const now = Date.now();
      const last = Number(await kv.get(key));

      /* 时间判断放在值里，不靠 TTL：KV 的 expirationTtl 下限是 60 秒，
         而私信窗口是 300 秒 —— TTL 若按旧写法固定 60 秒，冷却会在
         60 秒后随键过期静默失效。TTL 只负责事后回收，取下限与窗口的较大者。 */
      if (Number.isFinite(last) && last > 0) {
        const waitMs = windowSec * 1000 - (now - last);
        if (waitMs > 0) return Math.ceil(waitMs / 1000);
      }

      await kv.put(key, String(now), { expirationTtl: Math.max(60, Math.ceil(windowSec)) });
      return 0;
    },
  };

  return store;
}

/** 没绑 KV 时的兜底：单实例内存，isolate 重启即空。 */
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
    claim: async (visitorId, windowSec) => {
      const now = Date.now();
      const last = rate.get(visitorId);
      if (last !== undefined) {
        const waitMs = windowSec * 1000 - (now - last);
        if (waitMs > 0) return Math.ceil(waitMs / 1000);
      }
      rate.set(visitorId, now);
      return 0;
    },
  };
}

/**
 * 兜底存储必须建在**模块级**：Workers 的模块状态在同一 isolate 内跨请求存活，
 * 若在 onRequest 里现建一个，每次请求都是全新的空 Map —— 留言存不住，
 * 冷却也就永远不会触发（实测如此）。
 */
let memoryStore: GuestbookStore | undefined;

/** 按 env 装配存储：有 KV 就用 KV，没有才退化成内存兜底。 */
export function createGuestbookStore(env: Env): GuestbookStore {
  const kv = env.GUESTBOOK ?? env.VISITS;
  return kv ? createStore(kv) : (memoryStore ??= createMemoryStore());
}

/** 两个入口共用的配置；不带任何管理相关字段。 */
const baseOptions = (env: Env): GuestbookOptions => ({
  /* 开发默认盐：只为了让本地跑得通，上线务必用 GUESTBOOK_SALT 覆盖 */
  salt: env.GUESTBOOK_SALT ?? 'dev-salt-change-me',
  pushWebhook: env.GUESTBOOK_PUSH,
  emailTo: env.GUESTBOOK_EMAIL,
  emailFrom: env.GUESTBOOK_EMAIL_FROM,
  resendKey: env.RESEND_API_KEY,
  mailer: env.GUESTBOOK_MAILER,
  privateCooldownSec: parseCooldownSec(env.GUESTBOOK_DM_COOLDOWN),
});

/**
 * 公开接口的配置：**刻意不传 adminToken**，所以 `?scope=all` 与 DELETE
 * 在这条路径上永远是 403 —— 公开入口不存在管理能力，也就无从被绕过。
 */
export const publicOptions = (env: Env): GuestbookOptions => baseOptions(env);

/**
 * 管理接口的配置：认口令，且要求每个方法都先过鉴权。
 *
 * 口令保留为第二道锁是有意的：`*.pages.dev` 那个备用域名不在 Cloudflare Access
 * 的保护范围内（Access 策略按主机名生效），若哪天有人在那边直连，口令是唯一
 * 还站着的一道门。见 docs/留言板-实现路径.md 的「权限」一节。
 */
export const adminOptions = (env: Env): GuestbookOptions => ({
  ...baseOptions(env),
  adminToken: env.GUESTBOOK_ADMIN,
  requireAdmin: true,
});
