// src/server/server.ts
import 'dotenv/config';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { google, calendar_v3 } from 'googleapis';
import { DateTime } from 'luxon';
import * as chrono from 'chrono-node';
import { v4 as uuidv4 } from 'uuid';

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

/* =========================
  Google Calendar client
========================= */
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID!,
  process.env.GOOGLE_CLIENT_SECRET!
);
oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN! });

// Force concrete type so overloads resolve strictly
const calendar: calendar_v3.Calendar = google.calendar({
  version: 'v3',
  auth: oauth2,
}) as calendar_v3.Calendar;

/* =========================
  Validation
========================= */
const ScheduleRequestSchema = z
  .object({
    email: z.string().email(),
    label: z.string().optional(),
    startIso: z.string().datetime().optional(),
    durationMin: z.number().int().min(15).max(240).default(60),
    tz: z.string().default(DEFAULT_TZ),
    createMeet: z.boolean().default(true),
    allowOverbook: z.boolean().default(true),
    roomId: z.string().optional(),
    agentId: z.string().optional(),
    externalKey: z.string().optional(),
    summary: z.string().default('Grand Villa Tour'),
    location: z.string().default('Grand Villa of Clearwater'),
    description: z
      .string()
      .default(
        'Thank you for scheduling a visit to Grand Villa. This invite includes time, location, and directions. Diana will be waiting to welcome you.'
      ),
  })
  .refine((d) => d.label || d.startIso, {
    message: 'Either "label" or "startIso" must be provided',
  });

const RescheduleRequestSchema = z
  .object({
    eventId: z.string().optional(),
    email: z.string().email().optional(),
    label: z.string().optional(),
    startIso: z.string().datetime().optional(),
    durationMin: z.number().int().min(15).max(240).default(60),
    tz: z.string().default(DEFAULT_TZ),
    createMeet: z.boolean().default(true),
    allowOverbook: z.boolean().default(true),
    roomId: z.string().optional(),
    agentId: z.string().optional(),
    externalKey: z.string().optional(),
    summary: z.string().default('Grand Villa Tour'),
    location: z.string().default('Grand Villa of Clearwater'),
    description: z
      .string()
      .default(
        'Thank you for rescheduling your visit to Grand Villa. This invite includes time, location, and directions. Diana will be waiting to welcome you.'
      ),
  })
  .refine((d) => d.label || d.startIso, {
    message: 'Either "label" or "startIso" must be provided',
  })
  .refine((d) => !!(d.eventId || d.email), {
    message: 'Either "eventId" or "email" must be provided to locate the existing event',
  });

type ScheduleBody = z.infer<typeof ScheduleRequestSchema>;
type RescheduleBody = z.infer<typeof RescheduleRequestSchema>;

/* =========================
  Helpers
========================= */
function formatWhenText(dt: DateTime): string {
  return dt.toFormat("EEEE 'at' h:mm a");
}

function parseWithChrono(label: string, tz: string): DateTime | undefined {
  try {
    const parsed: Date | null = chrono.parseDate(label, new Date(), { forwardDate: true } as any);
    if (!parsed) return undefined;
    return DateTime.fromJSDate(parsed).setZone(tz, { keepLocalTime: true });
  } catch {
    return undefined;
  }
}

function parseLabelFallback(label: string, tz: string): DateTime | undefined {
  const dayRegex =
    /(sun|mon|tue|wed|thu|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i;
  const timeRegex = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

  const m = label.match(dayRegex);
  if (!m) return undefined;

  const map: Record<string, number> = {
    sun: 7, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
    sunday: 7, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  };
  const targetDow = map[m[0].toLowerCase()];
  if (!targetDow) return undefined;

  let hour = /afternoon/i.test(label) ? 15 : /morning/i.test(label) ? 10 : 10;
  let minute = 0;

  const after = label.slice((m.index ?? 0) + m[0].length);
  const t = after.match(timeRegex);
  if (t) {
    let h = parseInt(t[1], 10);
    const mm = t[2] ? parseInt(t[2], 10) : 0;
    const ap = t[3]?.toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    hour = h;
    minute = mm;
  }

  const now = DateTime.now().setZone(tz);
  let dt = now.set({ hour, minute, second: 0, millisecond: 0 });
  let delta = targetDow - now.weekday; // 1..7
  if (delta < 0) delta += 7;
  if (delta === 0 && dt <= now) delta = 7;
  dt = dt.plus({ days: delta });

  return dt.isValid ? dt : undefined;
}

function buildEventTimes(start: DateTime, durationMin: number): {
  startDateTime: string;
  endDateTime: string;
  end: DateTime;
} {
  const end = start.plus({ minutes: durationMin });
  const fmt = "yyyy-LL-dd'T'HH:mm:ss"; // local wall clock (no 'Z')
  return {
    startDateTime: start.toFormat(fmt),
    endDateTime: end.toFormat(fmt),
    end,
  };
}

async function findExistingEventByEmail(email: string): Promise<calendar_v3.Schema$Event | undefined> {
  const nowISO: string = new Date().toISOString();
  const maxISO: string | undefined = DateTime.now().plus({ days: 60 }).toISO() ?? undefined;

  const listParams: calendar_v3.Params$Resource$Events$List = {
    calendarId: CALENDAR_ID,
    timeMin: nowISO,
    timeMax: maxISO,
    singleEvents: true,
    maxResults: 50,
    orderBy: 'startTime',
    q: 'Grand Villa Tour',
  };
  const list = await calendar.events.list(listParams);
  const items = list.data.items ?? [];
  return items.find((ev) =>
    (ev.attendees ?? []).some((a) => a.email?.toLowerCase() === email.toLowerCase())
  );
}

/* =========================
  Server
========================= */
const app: FastifyInstance = Fastify({ logger: true });

await app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

app.get(
  '/health',
  async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    reply.send({ ok: true, tz: DEFAULT_TZ, calendarId: CALENDAR_ID });
  }
);

/**
 * POST /schedule — create new event
 */
app.post(
  '/schedule',
  async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> => {
    const parsed = ScheduleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      return;
    }

    const {
      email, label, startIso, durationMin, tz, createMeet,
      allowOverbook, roomId, agentId, externalKey, summary, location, description,
    } = parsed.data as ScheduleBody;

    try {
      // Resolve start time
      let startDt: DateTime | undefined;
      if (startIso) startDt = DateTime.fromISO(startIso, { setZone: true }).setZone(tz);
      else if (label) startDt = parseWithChrono(label, tz) ?? parseLabelFallback(label, tz);

      if (!startDt || !startDt.isValid) {
        reply.status(400).send({ ok: false, error: 'Could not parse date/time' });
        return;
      }

      const { startDateTime, endDateTime, end } = buildEventTimes(startDt, durationMin);

      // Idempotency key
      const idempKey: string =
        externalKey ?? `${roomId ?? ''}|${agentId ?? ''}|${email}|${startDateTime}|${tz}`;

      if (idempKey) {
        const dupParams: calendar_v3.Params$Resource$Events$List = {
          calendarId: CALENDAR_ID,
          privateExtendedProperty: [`externalKey=${idempKey}`],
          maxResults: 1,
          singleEvents: true,
        };
        const dup = await calendar.events.list(dupParams);
        if (dup.data.items?.length) {
          reply.status(409).send({
            ok: false,
            error: 'duplicate',
            whenText: formatWhenText(startDt),
            startIso: startDt.toISO() ?? undefined,
          });
          return;
        }
      }

      // Conflict check (skip if allowOverbook)
      if (!allowOverbook) {
        let hasConflict = false;
        try {
          const timeMinISO: string =
            startDt.toUTC().toISO() ?? new Date(startDt.toUTC().toMillis()).toISOString();
          const timeMaxISO: string =
            end.toUTC().toISO() ?? new Date(end.toUTC().toMillis()).toISOString();

          const fbParams: calendar_v3.Params$Resource$Freebusy$Query = {
            requestBody: {
              timeMin: timeMinISO,
              timeMax: timeMaxISO,
              items: [{ id: CALENDAR_ID }],
            },
          };
          const fb = await calendar.freebusy.query(fbParams);
          const busy = fb.data.calendars?.[CALENDAR_ID]?.busy ?? [];
          hasConflict = busy.length > 0;
        } catch (e: unknown) {
          const listParamsForConflict: calendar_v3.Params$Resource$Events$List = {
            calendarId: CALENDAR_ID,
            timeMin: startDt.toUTC().toISO() ?? undefined,
            timeMax: end.toUTC().toISO() ?? undefined,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 1,
          };
          const list = await calendar.events.list(listParamsForConflict);
          hasConflict = (list.data.items?.length ?? 0) > 0;
        }
        if (hasConflict) {
          reply.status(409).send({ ok: false, error: 'time_conflict' });
          return;
        }
      }

      // Create event
      const requestBody: calendar_v3.Schema$Event = {
        summary,
        description,
        location,
        start: { dateTime: startDateTime, timeZone: tz },
        end: { dateTime: endDateTime, timeZone: tz },
        attendees: [{ email }],
        guestsCanSeeOtherGuests: false,
        guestsCanInviteOthers: false,
        reminders: { useDefault: true },
        extendedProperties: { private: idempKey ? { externalKey: idempKey } : undefined },
        conferenceData: createMeet
          ? {
              createRequest: {
                requestId: uuidv4(),
                conferenceSolutionKey: { type: 'hangoutsMeet' },
              },
            }
          : undefined,
      };

      const insertParams: calendar_v3.Params$Resource$Events$Insert = {
        calendarId: CALENDAR_ID,
        requestBody,
        sendUpdates: 'all',
        conferenceDataVersion: createMeet ? 1 : 0,
      };

      const ins = await calendar.events.insert(insertParams);

      const link: string = ins.data.htmlLink ?? '';
      const whenText: string = formatWhenText(startDt);
      reply.send({
        ok: true,
        eventId: ins.data.id,
        htmlLink: link,
        whenText,
        startIso: startDt.toISO() ?? undefined,
      });
    } catch (err: unknown) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as any).message)
          : String(err);
      reply.status(500).send({ ok: false, error: message });
    }
  }
);

/**
 * POST /reschedule — create new event first, then delete the old one
 */
app.post(
  '/reschedule',
  async (req: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> => {
    const parsed = RescheduleRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.status(400).send({ ok: false, error: parsed.error.flatten() });
      return;
    }

    const {
      eventId, email, label, startIso, durationMin, tz, createMeet,
      roomId, agentId, externalKey, summary, location, description,
    } = parsed.data as RescheduleBody;

    try {
      // Find existing
      let existingEventId: string | undefined = eventId;
      if (!existingEventId && email) {
        const found = await findExistingEventByEmail(email);
        existingEventId = found?.id ?? undefined;
      }
      if (!existingEventId) {
        reply.status(404).send({ ok: false, error: 'existing_event_not_found' });
        return;
      }

      // Resolve new start
      let startDt: DateTime | undefined;
      if (startIso) startDt = DateTime.fromISO(startIso, { setZone: true }).setZone(tz);
      else if (label) startDt = parseWithChrono(label, tz) ?? parseLabelFallback(label, tz);

      if (!startDt || !startDt.isValid) {
        reply.status(400).send({ ok: false, error: 'Could not parse new date/time' });
        return;
      }

      const { startDateTime, endDateTime } = buildEventTimes(startDt, durationMin);

      const newKey: string =
        externalKey ?? `${roomId ?? ''}|${agentId ?? ''}|${email ?? ''}|${startDateTime}|${tz}`;

      // Create new event
      const reschedInsertParams: calendar_v3.Params$Resource$Events$Insert = {
        calendarId: CALENDAR_ID,
        requestBody: {
          summary,
          description,
          location,
          start: { dateTime: startDateTime, timeZone: tz },
          end: { dateTime: endDateTime, timeZone: tz },
          attendees: email ? [{ email }] : [],
          guestsCanSeeOtherGuests: false,
          guestsCanInviteOthers: false,
          reminders: { useDefault: true },
          extendedProperties: newKey ? { private: { externalKey: newKey } } : undefined,
          conferenceData: createMeet
            ? {
                createRequest: {
                  requestId: uuidv4(),
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              }
            : undefined,
        },
        sendUpdates: 'all',
        conferenceDataVersion: createMeet ? 1 : 0,
      };

      const newEvent = await calendar.events.insert(reschedInsertParams);

      // Delete old
      const deleteParams: calendar_v3.Params$Resource$Events$Delete = {
        calendarId: CALENDAR_ID,
        eventId: existingEventId,
        sendUpdates: 'all',
      };
      await calendar.events.delete(deleteParams);

      const whenText = formatWhenText(startDt);
      const link = newEvent.data.htmlLink ?? '';
      reply.send({
        ok: true,
        eventId: newEvent.data.id,
        htmlLink: link,
        whenText,
        startIso: startDt.toISO() ?? undefined,
      });
    } catch (err: unknown) {
      const message =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as any).message)
          : String(err);
      reply.status(500).send({ ok: false, error: message });
    }
  }
);

/* =========================
  Start
========================= */
app
  .listen({ host: '0.0.0.0', port: PORT })
  .then(() => app.log.info(`Server listening on http://127.0.0.1:${PORT}`))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
