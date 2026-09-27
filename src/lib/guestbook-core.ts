/**
 * 与平台无关的留言板逻辑：公开留言 + 私信站主。
 *
 * 同一份代码同时被两处使用：
 *   1. functions/api/guestbook.ts —— Cloudflare Pages Functions（KV 绑定）
 *   2. server/index.mjs           —— 任意 Node 机器（JSON 文件落盘）
 *
 * 只依赖标准 Request/Response 与 WebCrypto，不 import 任何平台 SDK。
 *
 * 两条通道共用一张表，用 visibility 区分：
 *   - public ：留在网站上的留言板，谁都能看。
 *   - private：只推给站主，不出现在公开列表里（管理口令可读）。
 *
 * 关于「昵称从哪来」——见 docs/留言板-实现路径.md：
 *   昵称 = 盐化指纹（IP + 浏览器/系统大类）→ 形容词 + 名词 + 4 位十六进制，
 *   原始 IP 不落库、不回传，指纹的盐由部署方持有，换盐等于给所有访客换名字。
 */

export type Visibility = 'public' | 'private';

export interface GuestbookEntry {
  id: string;
  nickname: string;
  message: string;
  createdAt: string;
  visibility: Visibility;
  /** 盐化指纹（10 位十六进制）：同一台设备长期不变，但反推不出 IP */
  visitorId: string;
  /** 以下三项只对管理口令可见，不进公开列表 */
  country?: string;
  agent?: string;
  /** 访客自己填的署名（留空则用系统给的昵称） */
  name?: string;
}

/** 公开接口返回的字段：昵称之外的指纹、地区、UA 一律不出网 */
export interface PublicEntry {
  id: string;
  nickname: string;
  message: string;
  createdAt: string;
}

export interface GuestbookStore {
  /** 按时间倒序取某个通道的留言 */
  list(visibility: Visibility, limit: number): Promise<GuestbookEntry[]>;
  /** 写入一条，返回该通道当前条数 */
  put(entry: GuestbookEntry): Promise<number>;
  /** 按 id 删除，返回是否删到了 */
  remove(id: string): Promise<boolean>;
  count(visibility: Visibility): Promise<number>;
  /** 限流：允许则返回 true；同一指纹在 windowSec 内重复请求返回 false */
  allow(visitorId: string, windowSec: number): Promise<boolean>;
}

export interface GuestbookOptions {
  /** 派生身份与昵称用的盐（部署时注入，务必保密） */
  salt: string;
  /** 私信推送地址：Bark / Server酱 / 任意接受 JSON 的端点；不配则跳过这一路 */
  pushWebhook?: string;
  /** 收件邮箱：配了它才走邮件通道（可多个，逗号分隔） */
  emailTo?: string;
  /** 发件人。Resend 没验证域名时用 onboarding@resend.dev，验证后换成自己的域名 */
  emailFrom?: string;
  /** Resend 的 API key（https://resend.com，免费额度 3000 封/月） */
  resendKey?: string;
  /** Cloudflare Email Routing 的 send_email 绑定（可选，零第三方） */
  mailer?: MailerLike;
  /** 管理口令：能读私信、能删留言；不配则管理接口一律 403 */
  adminToken?: string;
  /** 公开留言的限流窗口（秒），默认 20 */
  rateLimitSec?: number;
}

/** Cloudflare 的 send_email 绑定（Email Routing）最小接口 */
export interface MailerLike {
  send(message: {
    to: string | string[];
    from: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

export interface NotifyResult {
  /** 真正送出去的通道名，例如 ['resend'] */
  channels: string[];
  ok: boolean;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, must-revalidate',
};

const MAX_MESSAGE = 400;
const MAX_NAME = 24;
const MAX_BODY_BYTES = 8 * 1024;

/* ------------------------------ 昵称 ------------------------------ */

/* 24 × 24 = 576 个名字，够一个小站的留言板用；再撞就靠后面的指纹后缀区分。 */
const ADJECTIVES = [
  '青', '赤', '靛', '灰', '银', '苍', '幽', '微',
  '深', '浅', '冷', '暖', '暗', '亮', '静', '缓',
  '远', '近', '古', '新', '空', '湿', '淡', '钝',
];

const NOUNS = [
  '水母', '灯塔', '海豚', '电缆', '彗星', '沙丘', '礁石', '信标',
  '雾笛', '星尘', '潮汐', '罗盘', '桅杆', '潜航', '珊瑚', '极光',
  '水纹', '光缆', '星图', '白鲸', '流星', '深海', '盐雾', '浮标',
];

/* 只取「系统 + 浏览器」大类，不记具体版本：既能把同一出口 IP 下的两台设备分开，
   又不会因为浏览器小版本升级就把人变成另一个人。 */
export function platformTag(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  const os = /iphone|ipad|ipod/.test(ua)
    ? 'ios'
    : /android/.test(ua)
      ? 'android'
      : /mac os x|macintosh/.test(ua)
        ? 'macos'
        : /windows/.test(ua)
          ? 'windows'
          : /linux/.test(ua)
            ? 'linux'
            : 'other';
  const browser = /edg\//.test(ua)
    ? 'edge'
    : /firefox\//.test(ua)
      ? 'firefox'
      : /chrome\//.test(ua)
        ? 'chrome'
        : /safari\//.test(ua)
          ? 'safari'
          : 'other';
  return `${os}-${browser}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Visitor {
  /** 设备级指纹：同 IP 的不同浏览器/系统会分开 */
  visitorId: string;
  /** 出口级指纹：限流用，换 UA 也躲不掉 */
  rateKey: string;
  platform: string;
}

export async function deriveVisitor(request: Request, salt: string): Promise<Visitor> {
  const ip =
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown';
  const ua = request.headers.get('user-agent') ?? '';
  const platform = platformTag(ua);

  const deviceHash = await sha256Hex(`${salt}|device|${ip}|${platform}`);
  const rateHash = await sha256Hex(`${salt}|rate|${ip}`);

  return { visitorId: deviceHash.slice(0, 10), rateKey: rateHash.slice(0, 10), platform };
}

/** 由指纹推出昵称：形容词 + 名词 + 4 位后缀，例如「苍罗盘 #3f9a」 */
export function nicknameFor(visitorId: string): string {
  const a = parseInt(visitorId.slice(0, 2), 16) % ADJECTIVES.length;
  const n = parseInt(visitorId.slice(2, 4), 16) % NOUNS.length;
  const suffix = visitorId.slice(4, 8);
  return `${ADJECTIVES[a]}${NOUNS[n]} #${suffix}`;
}

/* ------------------------------ 校验 ------------------------------ */

/** 归一化：统一换行、去掉控制字符、压掉多余空白，长度按码点算 */
export function normalizeText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [...text].slice(0, max).join('');
}

const urlCount = (text: string): number => (text.match(/https?:\/\/|www\./gi) ?? []).length;

/* ------------------------------ 工具 ------------------------------ */

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  json({ error, ...extra }, status);

const newId = (): string =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const toPublic = (entry: GuestbookEntry): PublicEntry => ({
  id: entry.id,
  nickname: entry.nickname,
  message: entry.message,
  createdAt: entry.createdAt,
});

/* ---------------------------- 私信推送 ---------------------------- */

const mailSubject = (entry: GuestbookEntry): string => `私信 · ${entry.nickname}`;

/** 邮件正文：留言原样放最前，附加信息垫底，方便你在邮箱里一眼判断要不要回 */
const mailBody = (entry: GuestbookEntry): string =>
  [
    entry.message,
    '',
    '————————————',
    `来自：${entry.nickname}`,
    `时间：${entry.createdAt}`,
    entry.country ? `地区：${entry.country}` : '',
    entry.agent ? `设备：${entry.agent}` : '',
    `编号：${entry.id}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

const addressList = (raw: string): string[] =>
  raw.split(',').map((item) => item.trim()).filter(Boolean);

/** 通用 webhook：Bark / Server酱 / 任意收 JSON 的端点 */
async function notifyWebhook(webhook: string, entry: GuestbookEntry): Promise<boolean> {
  try {
    /* Server酱（sctapi.ftqq.com）吃表单 title/desp；Bark 与大多数端点吃 JSON。 */
    if (/sctapi\.ftqq\.com/.test(webhook)) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: mailSubject(entry), desp: entry.message }).toString(),
      });
      return res.ok;
    }

    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: mailSubject(entry),
        body: entry.message,
        nickname: entry.nickname,
        createdAt: entry.createdAt,
        country: entry.country,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Resend 的 HTTP API：免费额度够用，不用自建 SMTP */
async function notifyResend(
  key: string,
  from: string,
  to: string,
  entry: GuestbookEntry,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: addressList(to),
        subject: mailSubject(entry),
        text: mailBody(entry),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Cloudflare Email Routing 的 send_email 绑定：零第三方，但要先在那边的域名上开 */
async function notifyMailer(
  mailer: MailerLike,
  from: string,
  to: string,
  entry: GuestbookEntry,
): Promise<boolean> {
  try {
    await mailer.send({
      to: addressList(to),
      from,
      subject: mailSubject(entry),
      text: mailBody(entry),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 私信推给站主：邮件与手机推送可以同时配，谁成功算谁。
 * 任何一个通道失败都不影响留言落库 —— 读者不该为站主的通知配置背锅。
 */
export async function notifyOwner(
  entry: GuestbookEntry,
  options: GuestbookOptions,
): Promise<NotifyResult> {
  const channels: string[] = [];
  const to = options.emailTo?.trim();
  const from = options.emailFrom?.trim() || 'onboarding@resend.dev';

  if (to && options.mailer && (await notifyMailer(options.mailer, from, to, entry))) {
    channels.push('mailer');
  }
  if (to && options.resendKey && (await notifyResend(options.resendKey, from, to, entry))) {
    channels.push('resend');
  }
  if (options.pushWebhook && (await notifyWebhook(options.pushWebhook, entry))) {
    channels.push('webhook');
  }

  return { channels, ok: channels.length > 0 };
}

/* ------------------------------ 路由 ------------------------------ */

const clampLimit = (raw: string | null): number => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return Math.min(Math.floor(parsed), 100);
};

export async function handleGuestbook(
  request: Request,
  store: GuestbookStore,
  options: GuestbookOptions,
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { allow: 'GET, POST, DELETE, OPTIONS' } });
  }

  const url = new URL(request.url);
  const isAdmin = Boolean(options.adminToken) && url.searchParams.get('key') === options.adminToken;
  const rateLimitSec = options.rateLimitSec ?? 20;

  /* ---------------------------- 读 ---------------------------- */
  if (request.method === 'GET') {
    /* 表单要显示「你会以什么名字留言」，所以给一个只回昵称的轻接口 */
    if (url.searchParams.get('whoami') === '1') {
      const visitor = await deriveVisitor(request, options.salt);
      return json({
        visitorId: visitor.visitorId,
        platform: visitor.platform,
        nickname: nicknameFor(visitor.visitorId),
      });
    }

    const limit = clampLimit(url.searchParams.get('limit'));

    try {
      /* 管理视角：公开 + 私信一起给，带指纹/地区/UA，方便判断是谁 */
      if (url.searchParams.get('scope') === 'all') {
        if (!isAdmin) return fail(403, 'forbidden');
        const [pub, priv] = await Promise.all([
          store.list('public', limit),
          store.list('private', limit),
        ]);
        const entries = [...pub, ...priv].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json({ entries, counts: { public: await store.count('public'), private: await store.count('private') } });
      }

      const entries = await store.list('public', limit);
      return json({ entries: entries.map(toPublic), count: await store.count('public') });
    } catch (error) {
      return fail(503, 'store_unavailable', { detail: String(error) });
    }
  }

  /* --------------------------- 管理员删 --------------------------- */
  if (request.method === 'DELETE') {
    if (!isAdmin) return fail(403, 'forbidden');
    const id = url.searchParams.get('id');
    if (!id) return fail(400, 'missing_id');

    try {
      return json({ removed: await store.remove(id) });
    } catch (error) {
      return fail(503, 'store_unavailable', { detail: String(error) });
    }
  }

  /* ---------------------------- 写 ---------------------------- */
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: 'GET, POST, DELETE, OPTIONS' },
    });
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) return fail(413, 'payload_too_large');

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, 'invalid_json');
  }

  /* 蜜罐：真人看不见这个框，填了就当机器人处理。
     故意回 202 而不是 400 —— 让脚本以为自己成功了。 */
  if (normalizeText(payload.website, 20)) return json({ stored: false }, 202);

  /* 填表耗时：渲染到提交不足 1.5 秒的，基本是脚本 */
  const elapsed = Number(payload.elapsedMs);
  if (Number.isFinite(elapsed) && elapsed < 1500) return json({ stored: false }, 202);

  const message = normalizeText(payload.message, MAX_MESSAGE);
  if (message.length < 2) return fail(400, 'message_too_short');
  if (urlCount(message) > 2) return fail(400, 'too_many_links');

  const visibility: Visibility = payload.visibility === 'private' ? 'private' : 'public';
  const visitor = await deriveVisitor(request, options.salt);
  /* 访客自己填了署名就用他的；没填才用系统按设备推出来的代号 */
  const customName = normalizeText(payload.name, MAX_NAME);
  const nickname = customName || nicknameFor(visitor.visitorId);

  try {
    if (!(await store.allow(visitor.rateKey, rateLimitSec))) {
      return fail(429, 'rate_limited', { retryAfter: rateLimitSec });
    }

    const entry: GuestbookEntry = {
      id: newId(),
      nickname,
      message,
      createdAt: new Date().toISOString(),
      visibility,
      visitorId: visitor.visitorId,
      country: request.headers.get('cf-ipcountry') ?? undefined,
      agent: platformTag(request.headers.get('user-agent') ?? ''),
      name: customName || undefined,
    };

    const total = await store.put(entry);

    /* 只有私信才通知站主；通知失败不影响落库，但要如实告诉前端走了哪些通道 */
    const notify: NotifyResult =
      visibility === 'private'
        ? await notifyOwner(entry, options)
        : { channels: [], ok: false };

    return json(
      {
        stored: true,
        pushed: notify.ok,
        channels: notify.channels,
        total,
        entry: { ...toPublic(entry), visibility },
      },
      201,
    );
  } catch (error) {
    return fail(503, 'store_unavailable', { detail: String(error) });
  }
}
