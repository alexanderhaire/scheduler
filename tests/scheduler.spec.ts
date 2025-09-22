// tests/scheduler.spec.ts
/// <reference types="vitest" />

import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { DateTime } from 'luxon';
import type { calendar_v3 } from 'googleapis';

type Ev = calendar_v3.Schema$Event;

// We assign this after dynamic import so NODE_ENV can be set first.
let buildServer: (calendarOverride?: calendar_v3.Calendar) => Promise<any>;

/**
 * Minimal in-memory fake of the Google Calendar client.
 * Implements just the parts we use: events.list and events.insert.
 */
class FakeCalendar {
  private seq = 0;
  private store: Ev[] = [];

  constructor(seed: Ev[] = []) {
    this.store = seed.map((e) => ({ ...e }));
  }

  // Simulate Calendar.Events.list
  private listImpl = async (params: calendar_v3.Params$Resource$Events$List) => {
    const items = this.store
      .filter((e) => {
        const s = e.start?.dateTime ?? e.start?.date;
        const ee = e.end?.dateTime ?? e.end?.date;
        if (!s || !ee) return false;

        const start = DateTime.fromISO(s, { setZone: true }).toUTC();
        const end = DateTime.fromISO(ee, { setZone: true }).toUTC();
        if (!start.isValid || !end.isValid) return false;

        const min = params.timeMin ? DateTime.fromISO(params.timeMin).toUTC() : undefined;
        const max = params.timeMax ? DateTime.fromISO(params.timeMax).toUTC() : undefined;

        const overlapsMin = !min || end > min;
        const overlapsMax = !max || start < max;
        return overlapsMin && overlapsMax;
      })
      .sort((a, b) => {
        const as = a.start?.dateTime ?? a.start?.date ?? '';
        const bs = b.start?.dateTime ?? b.start?.date ?? '';
        return as.localeCompare(bs);
      });

    // Shape compatible with googleapis' GaxiosResponse.data
    return { data: { items } } as unknown as { data: calendar_v3.Schema$Events };
  };

  // Simulate Calendar.Events.insert
  private insertImpl = async (params: calendar_v3.Params$Resource$Events$Insert) => {
    const body = params.requestBody!;
    const id = `book-${++this.seq}`;

    const start = body.start?.dateTime!;
    const end = body.end?.dateTime!;
    const tz = body.start?.timeZone;

    this.store.push({
      id,
      status: 'confirmed',
      start: { dateTime: start, timeZone: tz },
      end: { dateTime: end, timeZone: tz },
    });

    return { data: { id, htmlLink: `https://calendar.local/${id}` } };
  };

  public events = {
    list: this.listImpl,
    insert: this.insertImpl,
  };
}

describe('eliza-scheduler endpoints (5-minute slots, bump +5m)', () => {
  let app: any;

  beforeEach(async () => {
    // Ensure the production server does NOT auto-listen on import.
    process.env.NODE_ENV = 'test';
    process.env.GOOGLE_CLIENT_ID = 'test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'test-refresh';
    process.env.GOOGLE_CALENDAR_ID = 'primary';
    process.env.TZ = 'America/New_York';

    // Import AFTER setting env so the module’s prod listener guard is respected.
    ({ buildServer } = await import('../src/server'));

    // Seed: Busy at 21:30Z–21:35Z (which is 5:30–5:35pm ET on 2025-09-22)
    const seedBusy: Ev[] = [
      {
        id: 'busy-1',
        status: 'confirmed',
        start: { dateTime: '2025-09-22T21:30:00Z' },
        end: { dateTime: '2025-09-22T21:35:00Z' },
      },
    ];

    const fake = new FakeCalendar(seedBusy) as unknown as calendar_v3.Calendar;
    app = await buildServer(fake); // build Fastify app wired to our fake calendar
  });

  afterEach(async () => {
    if (app?.close) await app.close();
  });

  it('GET /v1/availability/soonest → returns the next free 5-minute slot', async () => {
    const from = '2025-09-22T17:30:00-04:00'; // 21:30Z, which is currently BUSY
    const res = await app.inject({
      method: 'GET',
      url: `/v1/availability/soonest?from=${encodeURIComponent(from)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Should bump to 21:35Z–21:40Z because 21:30Z–21:35Z is busy
    expect(body.startIso).toBe('2025-09-22T21:35:00.000Z');
    expect(body.endIso).toBe('2025-09-22T21:40:00.000Z');
    expect(body.slotMinutes).toBe(5);
    expect(body.calendarId).toBe('primary');
  });

  it('PUT /v1/meetings → bumps forward by +5m when requested slot is busy', async () => {
    const payload = {
      requestedStartIso: '2025-09-22T17:30:00-04:00', // 21:30Z (busy)
      email: 'alex@example.com',
      label: 'Tour with Diana',
    };

    const res = await app.inject({
      method: 'PUT',
      url: '/v1/meetings',
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Should be scheduled at 21:35Z–21:40Z
    expect(body.bumpedFromRequested).toBe(true);
    expect(body.scheduledStartIso).toBe('2025-09-22T21:35:00.000Z');
    expect(body.scheduledEndIso).toBe('2025-09-22T21:40:00.000Z');
    expect(body.slotMinutes).toBe(5);
    expect(typeof body.eventId).toBe('string');
  });

  it('PUT /v1/meetings → stacks back-to-back (second request bumps again)', async () => {
    const payload = {
      requestedStartIso: '2025-09-22T17:30:00-04:00', // 21:30Z
      email: 'alex@example.com',
      label: 'Tour with Diana',
    };

    // First booking: with 21:30Z busy, should book 21:35Z
    const r1 = await app.inject({ method: 'PUT', url: '/v1/meetings', payload });
    const b1 = r1.json();
    expect(b1.scheduledStartIso).toBe('2025-09-22T21:35:00.000Z');

    // Second identical booking (now 21:30Z and 21:35Z are taken): should book 21:40Z
    const r2 = await app.inject({ method: 'PUT', url: '/v1/meetings', payload });
    const b2 = r2.json();
    expect(b2.scheduledStartIso).toBe('2025-09-22T21:40:00.000Z');
    expect(b2.bumpedFromRequested).toBe(true);
  });
});
