// src/server.ts
import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { google, calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { DateTime, IANAZone } from 'luxon';
import { readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* =========================
   Env & constants
========================= */
function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

const CLIENT_ID = readEnv('GOOGLE_CLIENT_ID', 'CLIENT_ID');
const CLIENT_SECRET = readEnv('GOOGLE_CLIENT_SECRET', 'CLIENT_SECRET');
const REDIRECT_URI = readEnv('GOOGLE_REDIRECT_URI', 'REDIRECT_URI') ?? 'http://localhost:4005/oauth2callback';

if (!CLIENT_ID) throw new Error('Environment variable GOOGLE_CLIENT_ID (or CLIENT_ID) is required');
if (!CLIENT_SECRET) throw new Error('Environment variable GOOGLE_CLIENT_SECRET (or CLIENT_SECRET) is required');

const PORT: number = Number(process.env.PORT ?? 4005);
const DEFAULT_TZ: string = process.env.TZ || 'America/New_York';
const DEFAULT_CALENDAR_ID: string = process.env.GOOGLE_CALENDAR_ID || 'primary';

const COOKIE_NAME = 'uid'; // stores Google user ID (from userinfo.id)
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'dev-cookie-secret';
const DATA_DIR = process.env.DATA_DIR || resolve(process.cwd(), 'data/tokens');

const SLOT_MINUTES = 5;
const AVAIL_HORIZON_DAYS = 30;

const OAUTH_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
];

// ESM-safe __dirname + public dir
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '../public');

/* =========================
   Token storage (disk demo)
========================= */
type StoredTokens = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expiry_date?: number;
  id_token?: string;
  token_type?: string;
  email?: string;
  sub?: string; // Google user id (userinfo.id)
};

async function ensureDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}
function tokenPathForUser(userId: string) {
  return resolve(DATA_DIR, `${userId}.json`);
}
async function loadUserTokens(userId: string): Promise<StoredTokens | null> {
  try {
    const buf = await fsp.readFile(tokenPathForUser(userId), 'utf8');
    return JSON.parse(buf) as StoredTokens;
  } catch {
    return null;
  }
}
async function saveUserTokens(userId: string, tokens: StoredTokens) {
  await ensureDir(DATA_DIR);
  await fsp.writeFile(tokenPathForUser(userId), JSON.stringify(tokens, null, 2), 'utf8');
}

/* =========================
   OAuth helpers
========================= */
function createOAuthClient(): OAuth2Client {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

async function getUserInfo(auth: OAuth2Client): Promise<{ id: string; email?: string }> {
  const oauth2 = google.oauth2({ version: 'v2', auth });
  const { data } = await oauth2.userinfo.get();
  const id = data.id ?? ''; // 'sub' isn't in Schema$Userinfo typings
  if (!id) throw new Error('oauth_no_user_id');
  return { id, email: data.email ?? undefined };
}

/* =========================
   Calendar per-user
========================= */
async function getCalendarForUser(
  userId: string,
  override?: calendar_v3.Calendar
): Promise<calendar_v3.Calendar> {
  if (override) return override;
  const tokens = await loadUserTokens(userId);
  if (!tokens?.refresh_token && !tokens?.access_token) throw new Error('auth_required');
  const oauth = createOAuthClient();
  oauth.setCredentials(tokens as any); // library accepts partial creds; auto-refreshes with refresh_token
  return google.calendar({ version: 'v3', auth: oauth }) as calendar_v3.Calendar;
}

/* =========================
   Time helpers
========================= */
function roundUpToMinutesUTC(dt: DateTime, minutes: number): DateTime {
  const utc = dt.toUTC();
  const stepMs = minutes * 60_000;
  const rounded = Math.ceil(utc.toMillis() / stepMs) * stepMs;
  return DateTime.fromMillis(rounded, { zone: 'utc' }).set({ second: 0, millisecond: 0 });
}
function parseEventDateTimesToUTC(
  ev: calendar_v3.Schema$Event
): { start: DateTime; end: DateTime } | null {
  const startStr = ev.start?.dateTime ?? ev.start?.date;
  const endStr = ev.end?.dateTime ?? ev.end?.date;
  if (!startStr || !endStr) return null;
  if (ev.status === 'cancelled') return null;
  if (ev.transparency === 'transparent') return null;

  const isAllDay = !!ev.start?.date && !ev.start?.dateTime;
  if (isAllDay) {
    const startLocal = DateTime.fromISO(startStr, { zone: DEFAULT_TZ }).startOf('day');
    const endLocal = DateTime.fromISO(endStr, { zone: DEFAULT_TZ }).startOf('day');
    return { start: startLocal.toUTC(), end: endLocal.toUTC() };
  }

  const start = DateTime.fromISO(startStr, { setZone: true }).toUTC();
  const end = DateTime.fromISO(endStr, { setZone: true }).toUTC();
  if (!start.isValid || !end.isValid || end <= start) return null;
  return { start, end };
}
function mergeBlocks(blocks: Array<{ start: DateTime; end: DateTime }>) {
  const sorted = blocks.slice().sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const merged: Array<{ start: DateTime; end: DateTime }> = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (!last || b.start > last.end) merged.push({ ...b });
    else if (b.end > last.end) last.end = b.end;
  }
  return merged;
}

/* =========================
   Scheduler (closes over calendar)
========================= */
function makeScheduler(cal: calendar_v3.Calendar, calendarId: string) {
  async function findFirstFreeSlotFromUTC(fromUTC: DateTime): Promise<DateTime> {
    const startUTC = roundUpToMinutesUTC(fromUTC, SLOT_MINUTES);
    const endUTC = startUTC.plus({ days: AVAIL_HORIZON_DAYS });
    const timeMin = startUTC.toISO()!;
    const timeMax = endUTC.toISO()!;

    let pageToken: string | undefined = undefined;
    const blocks: Array<{ start: DateTime; end: DateTime }> = [];

    do {
      const res: calendar_v3.Schema$Events = (await cal.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
        showDeleted: false,
      })).data;

      const items: calendar_v3.Schema$Event[] = res.items ?? [];
      for (const ev of items) {
        const se = parseEventDateTimesToUTC(ev);
        if (se) blocks.push(se);
      }
      pageToken = res.nextPageToken ?? undefined;
    } while (pageToken);

    const merged = mergeBlocks(blocks);
    let t = startUTC;
    for (const b of merged) {
      if (t.plus({ minutes: SLOT_MINUTES }) <= b.start) return t;
      if (t < b.end) t = roundUpToMinutesUTC(b.end, SLOT_MINUTES);
    }
    return t;
  }

  async function scheduleAtOrNextUTC(
    requestedUTC: DateTime,
    opts: { email?: string; label?: string; tz?: string; summary?: string; location?: string }
  ) {
    const tz = opts.tz ?? DEFAULT_TZ;
    const summary = opts.summary ?? 'Grand Villa Tour';
    const loc = opts.location ?? 'Grand Villa of Clearwater';

    const roundedReqUTC = roundUpToMinutesUTC(requestedUTC, SLOT_MINUTES);
    const chosenUTC = await findFirstFreeSlotFromUTC(roundedReqUTC);
    const bumped = chosenUTC.toMillis() !== roundedReqUTC.toMillis();

    const startLocal = chosenUTC.setZone(tz);
    const startDateTime = startLocal.toISO({ suppressMilliseconds: true })!;
    const endDateTime = startLocal.plus({ minutes: SLOT_MINUTES }).toISO({ suppressMilliseconds: true })!;

    const externalKey = [
      'grand-villa',
      'diana',
      opts.email ?? 'anon',
      startLocal.toISO({ suppressMilliseconds: true }),
      opts.label ?? ''
    ].join('|');

    try {
      const existing = await cal.events.list({
        calendarId,
        privateExtendedProperty: [`externalKey=${externalKey}`],
        timeMin: startLocal.toUTC().toISO()!,
        timeMax: startLocal.plus({ minutes: SLOT_MINUTES }).toUTC().toISO()!,
        singleEvents: true,
        maxResults: 1,
        showDeleted: false,
      });
      const hit = existing.data.items?.[0];
      if (hit?.id) {
        return { chosenUTC, bumped, eventId: hit.id, htmlLink: hit.htmlLink ?? undefined };
      }
    } catch {
      /* ignore filter issues */
    }

    const requestBody: calendar_v3.Schema$Event = {
      summary,
      description: `5-minute appointment with Diana${opts.label ? ` — ${opts.label}` : ''}`,
      location: loc,
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      attendees: opts.email ? [{ email: opts.email }] : undefined,
      guestsCanSeeOtherGuests: false,
      guestsCanInviteOthers: false,
      reminders: { useDefault: true },
      extendedProperties: { private: { externalKey } },
    };

    const ins = await cal.events.insert({
      calendarId,
      requestBody,
      sendUpdates: 'all',
    });

    return {
      chosenUTC,
      bumped,
      eventId: ins.data.id,
      htmlLink: ins.data.htmlLink ?? undefined,
    };
  }

  return { findFirstFreeSlotFromUTC, scheduleAtOrNextUTC };
}

/* =========================
   Validation Schemas
========================= */
const isoLike = z
  .string()
  .refine((s) => DateTime.fromISO(s, { setZone: true }).isValid, { message: 'Invalid ISO datetime' });
const tzLike = z
  .string()
  .refine((s) => IANAZone.isValidZone(s), { message: 'Invalid IANA timezone' });

const GetSoonestQuery = z.object({ from: isoLike.optional() });
const PutMeetingBody = z.object({
  requestedStartIso: isoLike,
  email: z.string().email().optional(),
  label: z.string().optional(),
  tz: tzLike.optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
});

/* =========================
   Build the server
========================= */
export async function buildServer(calendarOverride?: calendar_v3.Calendar): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: true });

  await app.register(cors, { origin: true, methods: ['GET', 'PUT', 'OPTIONS'] });
  await app.register(cookie, { secret: COOKIE_SECRET, hook: 'onRequest' });

  // Serve static UI from /public (index.html, app.html, etc.)
  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/', // e.g., /index.html
  });

  // Serve openapi.yaml (optional)
  const OPENAPI_PATH = resolve(__dirname, '../openapi.yaml');
  let OPENAPI_YAML = '';
  try {
    OPENAPI_YAML = readFileSync(OPENAPI_PATH, 'utf8');
  } catch {
    app.log.warn(`openapi.yaml not found at ${OPENAPI_PATH}`);
  }
  app.get('/openapi.yaml', async (_req, reply) => {
    if (!OPENAPI_YAML) return reply.status(404).send({ error: 'missing_openapi' });
    reply.type('text/yaml').send(OPENAPI_YAML);
  });

  // Health
  app.get('/health', async (_req, reply) => {
    reply.send({ ok: true, tz: DEFAULT_TZ, calendarIdDefault: DEFAULT_CALENDAR_ID, slotMinutes: SLOT_MINUTES });
  });

  /* ----- Auth: start Google OAuth (server-side redirect) ----- */
  app.get('/auth/google', async (req, reply) => {
    const next = (req.query as any)?.next || '/';
    const state = Buffer.from(JSON.stringify({ next })).toString('base64url');

    const oauth = createOAuthClient();
    const url = oauth.generateAuthUrl({
      access_type: 'offline',             // get refresh_token
      prompt: 'consent',                  // ensure refresh on first connect
      include_granted_scopes: true,
      scope: OAUTH_SCOPES,
      state,
    });
    reply.redirect(url);
  });

  /* ----- Auth: OAuth callback (exchange code → tokens, store, set cookie) ----- */
  app.get('/oauth2callback', async (req, reply) => {
    try {
      const q = req.query as any;
      if (q.error) return reply.status(400).send({ error: q.error });

      const code = q.code as string;
      if (!code) return reply.status(400).send({ error: 'missing_code' });

      const oauth = createOAuthClient();
      const { tokens } = await oauth.getToken(code);
      oauth.setCredentials(tokens);

      const { id: userId, email } = await getUserInfo(oauth);

      // Normalize nulls to undefined to satisfy StoredTokens type
      const cleaned: StoredTokens = {
        access_token: tokens.access_token ?? undefined,
        refresh_token: tokens.refresh_token ?? undefined,
        scope: tokens.scope,
        expiry_date: tokens.expiry_date ?? undefined,
        id_token: tokens.id_token ?? undefined,
        token_type: tokens.token_type ?? undefined,
        email,
        sub: userId,
      };

      await saveUserTokens(userId, cleaned);

      reply.setCookie(COOKIE_NAME, userId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production', // dev-friendly
      });

      let next = '/';
      if (q.state) {
        try { next = JSON.parse(Buffer.from(q.state, 'base64url').toString('utf8')).next || '/'; }
        catch { /* ignore */ }
      }
      reply.redirect(next);
    } catch (err: any) {
      req.log.error({ err }, 'oauth_callback_failed');
      reply.status(500).send({ error: 'oauth_callback_failed', message: err?.message ?? 'unknown' });
    }
  });

  /* ----- Who am I? (helpful for the UI) ----- */
  app.get('/me', async (req, reply) => {
    if (calendarOverride) {
      reply.send({ authenticated: true, userId: 'service-user', email: null });
      return;
    }

    const uid = (req.cookies as any)?.[COOKIE_NAME];
    if (!uid) return reply.status(401).send({ authenticated: false, login: '/auth/google' });
    const tokens = await loadUserTokens(uid);
    reply.send({ authenticated: !!tokens, userId: uid, email: tokens?.email ?? null });
  });

  /* ----- Logout ----- */
  app.get('/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    reply.send({ ok: true });
  });

  /* ----- Simple auth guard ----- */
  async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> {
    if (calendarOverride) return 'service-user';

    const uid = (req.cookies as any)?.[COOKIE_NAME];
    if (!uid) {
      reply.status(401).send({ error: 'auth_required', login: '/auth/google' });
      return;
    }
    const tokens = await loadUserTokens(uid);
    if (!tokens) {
      reply.status(401).send({ error: 'auth_required', login: '/auth/google' });
      return;
    }
    return uid;
  }

  /* ----- Availability ----- */
  app.get('/v1/availability/soonest', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const uid = await requireUser(req, reply); if (!uid) return;

      const parsed = GetSoonestQuery.safeParse(req.query ?? {});
      if (!parsed.success) return reply.status(400).send({ error: 'bad_request', details: parsed.error.flatten() });

      const fromStr = parsed.data.from;
      const base = fromStr ? DateTime.fromISO(fromStr, { setZone: true }) : DateTime.now();
      if (!base.isValid) return reply.status(400).send({ error: 'invalid_from' });

      const cal = await getCalendarForUser(uid, calendarOverride);
      const calId = DEFAULT_CALENDAR_ID; // 'primary' by default
      const { findFirstFreeSlotFromUTC } = makeScheduler(cal, calId);

      const startUTC = await findFirstFreeSlotFromUTC(base);
      const endUTC = startUTC.plus({ minutes: SLOT_MINUTES });

      reply.send({
        startIso: startUTC.toISO(),
        endIso: endUTC.toISO(),
        slotMinutes: SLOT_MINUTES,
        tz: DEFAULT_TZ,
        calendarId: calId,
      });
    } catch (err: any) {
      req.log.error({ err }, 'soonest lookup failed');
      const status = Number(err?.code ?? err?.statusCode ?? 500);
      const msg =
        err?.errors?.[0]?.message ??
        err?.response?.data?.error?.message ??
        err?.message ?? 'server_error';
      reply.status(status).send({ error: 'gcal_error', message: msg });
    }
  });

  /* ----- Booking ----- */
  app.put('/v1/meetings', async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    try {
      const uid = await requireUser(req, reply); if (!uid) return;

      const parsed = PutMeetingBody.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: 'bad_request', details: parsed.error.flatten() });

      const { requestedStartIso, email, label, tz, summary, location } = parsed.data;
      const requested = DateTime.fromISO(requestedStartIso, { setZone: true });
      if (!requested.isValid) return reply.status(400).send({ error: 'invalid_requestedStartIso' });

      const cal = await getCalendarForUser(uid, calendarOverride);
      const calId = DEFAULT_CALENDAR_ID;
      const { scheduleAtOrNextUTC } = makeScheduler(cal, calId);

      const { chosenUTC, bumped, eventId, htmlLink } = await scheduleAtOrNextUTC(requested, {
        email, label, tz, summary, location,
      });

      reply.send({
        scheduledStartIso: chosenUTC.toISO(),
        scheduledEndIso: chosenUTC.plus({ minutes: SLOT_MINUTES }).toISO(),
        bumpedFromRequested: bumped,
        eventId,
        htmlLink,
        slotMinutes: SLOT_MINUTES,
      });
    } catch (err: any) {
      req.log.error({ err }, 'booking failed');
      const status = Number(err?.code ?? err?.statusCode ?? 500);
      const msg =
        err?.errors?.[0]?.message ??
        err?.response?.data?.error?.message ??
        err?.message ?? 'server_error';
      reply.status(status).send({ error: 'gcal_error', message: msg });
    }
  });

  return app;
}

/* =========================
   Start (prod only)
========================= */
if (process.env.NODE_ENV !== 'test') {
  const app = await buildServer();
  app
    .listen({ host: '0.0.0.0', port: PORT })
    .then(() => app.log.info(`Scheduler listening on http://127.0.0.1:${PORT}`))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
