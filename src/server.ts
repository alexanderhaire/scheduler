// src/server.ts
import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { google, calendar_v3 } from 'googleapis';
import { DateTime, IANAZone } from 'luxon';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/* =========================
  Env & constants
========================= */
const REQUIRED_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) throw new Error(`Environment variable ${key} is required`);
}

const PORT: number = Number(process.env.PORT ?? 4005);
const CALENDAR_ID: string = process.env.GOOGLE_CALENDAR_ID || 'primary';
const DEFAULT_TZ: string = process.env.TZ || 'America/New_York';
const SLOT_MINUTES = 5;
const AVAIL_HORIZON_DAYS = 30;

/* =========================
  Google Calendar client (prod)
========================= */
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!
);
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN! });

const realCalendar: calendar_v3.Calendar = google.calendar({
  version: 'v3',
  auth: oauth2,
}) as calendar_v3.Calendar;

/* =========================
  Pure helpers
========================= */
function roundUpToMinutesUTC(dt: DateTime, minutes: number): DateTime {
  const utc = dt.toUTC();
  const stepMs = minutes * 60_000;
  const rounded = Math.ceil(utc.toMillis() / stepMs) * stepMs;
  return DateTime.fromMillis(rounded, { zone: 'utc' }).set({ second: 0, millisecond: 0 });
}

function buildEventTimes(startLocal: DateTime, durationMin: number): {
  startDateTime: string;
  endDateTime: string;
  end: DateTime;
} {
  const end = startLocal.plus({ minutes: durationMin });
  const fmt = "yyyy-LL-dd'T'HH:mm:ss";
  return {
    startDateTime: startLocal.toFormat(fmt),
    endDateTime: end.toFormat(fmt),
    end,
  };
}

function parseEventDateTimesToUTC(
  ev: calendar_v3.Schema$Event
): { start: DateTime; end: DateTime } | null {
  const startStr = ev.start?.dateTime ?? ev.start?.date;
  const endStr = ev.end?.dateTime ?? ev.end?.date;
  if (!startStr || !endStr) return null;

  // Transparent & cancelled events shouldn't block
  if (ev.status === 'cancelled') return null;
  if (ev.transparency === 'transparent') return null;

  const isAllDay = !!ev.start?.date && !ev.start?.dateTime;
  if (isAllDay) {
    // Treat as blocking the whole day in DEFAULT_TZ
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
    if (!last || b.start > last.end) {
      merged.push({ ...b });
    } else if (b.end > last.end) {
      last.end = b.end;
    }
  }
  return merged;
}

/* =========================
  Helpers that close over a calendar client
========================= */
function makeScheduler(cal: calendar_v3.Calendar) {
  async function findFirstFreeSlotFromUTC(fromUTC: DateTime): Promise<DateTime> {
    const startUTC = roundUpToMinutesUTC(fromUTC, SLOT_MINUTES);
    const endUTC = startUTC.plus({ days: AVAIL_HORIZON_DAYS });

    const timeMin = startUTC.toISO()!;
    const timeMax = endUTC.toISO()!;

    let pageToken: string | undefined = undefined;
    const blocks: Array<{ start: DateTime; end: DateTime }> = [];

    do {
      const listParams: calendar_v3.Params$Resource$Events$List = {
        calendarId: CALENDAR_ID,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 2500,
        pageToken,
        showDeleted: false,
      };

      const res: calendar_v3.Schema$Events = (await cal.events.list(listParams)).data;
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
      // If we can fit a 5-min slot before the next busy block, take it
      if (t.plus({ minutes: SLOT_MINUTES }) <= b.start) return t;
      // Otherwise jump to the end of the busy block, rounded up
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
    const location = opts.location ?? 'Grand Villa of Clearwater';

    const roundedReqUTC = roundUpToMinutesUTC(requestedUTC, SLOT_MINUTES);
    const chosenUTC = await findFirstFreeSlotFromUTC(roundedReqUTC);
    const bumped = chosenUTC.toMillis() !== roundedReqUTC.toMillis();

    const startLocal = chosenUTC.setZone(tz);
    const { startDateTime, endDateTime } = buildEventTimes(startLocal, SLOT_MINUTES);

    // Optional idempotency key to avoid double-booking on concurrent PUTs.
    const externalKey = [
      'grand-villa', // room or site
      'diana',       // agent
      opts.email ?? 'anon',
      startLocal.toISO({ suppressMilliseconds: true }),
      opts.label ?? ''
    ].join('|');

    // Check if we already created this exact event (idempotency)
    try {
      const existing = await cal.events.list({
        calendarId: CALENDAR_ID,
        privateExtendedProperty: [`externalKey=${externalKey}`],
        timeMin: startLocal.toUTC().toISO()!,
        timeMax: startLocal.plus({ minutes: SLOT_MINUTES }).toUTC().toISO()!,
        singleEvents: true,
        maxResults: 1,
        showDeleted: false,
      });
      const hit = existing.data.items?.[0];
      if (hit?.id) {
        return {
          chosenUTC,
          bumped,
          eventId: hit.id,
          htmlLink: hit.htmlLink ?? undefined,
        };
      }
    } catch {
      // If the filter isn’t supported/available, we’ll proceed to create.
    }

    const requestBody: calendar_v3.Schema$Event = {
      summary,
      description: `5-minute appointment with Diana${opts.label ? ` — ${opts.label}` : ''}`,
      location,
      start: { dateTime: startDateTime, timeZone: tz },
      end: { dateTime: endDateTime, timeZone: tz },
      attendees: opts.email ? [{ email: opts.email }] : undefined,
      guestsCanSeeOtherGuests: false,
      guestsCanInviteOthers: false,
      reminders: { useDefault: true },
      extendedProperties: {
        private: { externalKey },
      },
    };

    const insertParams: calendar_v3.Params$Resource$Events$Insert = {
      calendarId: CALENDAR_ID,
      requestBody,
      sendUpdates: 'all',
    };

    const ins = await cal.events.insert(insertParams);

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

const GetSoonestQuery = z.object({
  from: isoLike.optional(),
});

const PutMeetingBody = z.object({
  requestedStartIso: isoLike,
  email: z.string().email().optional(),
  label: z.string().optional(),
  tz: tzLike.optional(),
  summary: z.string().optional(),
  location: z.string().optional(),
});

/* =========================
  Build the server (injectable)
========================= */
export async function buildServer(calendarOverride?: calendar_v3.Calendar): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: true });
  await app.register(cors, { origin: true, methods: ['GET', 'PUT', 'OPTIONS'] });

  // ---- OpenAPI serving (no extra deps) ----
  const __dirname = dirname(fileURLToPath(import.meta.url));
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

  const cal = (calendarOverride ?? realCalendar) as calendar_v3.Calendar;
  const { findFirstFreeSlotFromUTC, scheduleAtOrNextUTC } = makeScheduler(cal);

  app.get('/health', async (_req, reply) => {
    reply.send({ ok: true, tz: DEFAULT_TZ, calendarId: CALENDAR_ID, slotMinutes: SLOT_MINUTES });
  });

  app.get(
    '/v1/availability/soonest',
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        const parsed = GetSoonestQuery.safeParse(req.query ?? {});
        if (!parsed.success) {
          reply.status(400).send({ error: 'bad_request', details: parsed.error.flatten() });
          return;
        }

        const fromStr = parsed.data.from;
        const base = fromStr ? DateTime.fromISO(fromStr, { setZone: true }) : DateTime.now();
        if (!base.isValid) {
          reply.status(400).send({ error: 'invalid_from' });
          return;
        }

        const startUTC = await findFirstFreeSlotFromUTC(base);
        const endUTC = startUTC.plus({ minutes: SLOT_MINUTES });

        reply.send({
          startIso: startUTC.toISO(),
          endIso: endUTC.toISO(),
          slotMinutes: SLOT_MINUTES,
          tz: DEFAULT_TZ,
          calendarId: CALENDAR_ID,
        });
      } catch (err: any) {
        req.log.error({ err }, 'soonest lookup failed');
        const status = Number(err?.code ?? err?.statusCode ?? 500);
        const msg =
          err?.errors?.[0]?.message ??
          err?.response?.data?.error?.message ??
          err?.message ??
          'server_error';
        reply.status(status).send({ error: 'gcal_error', message: msg });
      }
    }
  );

  app.put(
    '/v1/meetings',
    async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> => {
      try {
        const parsed = PutMeetingBody.safeParse(req.body);
        if (!parsed.success) {
          reply.status(400).send({ error: 'bad_request', details: parsed.error.flatten() });
          return;
        }

        const { requestedStartIso, email, label, tz, summary, location } = parsed.data;
        const requested = DateTime.fromISO(requestedStartIso, { setZone: true });
        if (!requested.isValid) {
          reply.status(400).send({ error: 'invalid_requestedStartIso' });
          return;
        }

        const { chosenUTC, bumped, eventId, htmlLink } = await scheduleAtOrNextUTC(requested, {
          email,
          label,
          tz,
          summary,
          location,
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
          err?.message ??
          'server_error';
        reply.status(status).send({ error: 'gcal_error', message: msg });
      }
    }
  );

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
