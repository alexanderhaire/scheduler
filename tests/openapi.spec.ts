/// <reference types="vitest" />
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import type { calendar_v3 } from 'googleapis';

let buildServer: (calendarOverride?: calendar_v3.Calendar) => Promise<any>;

class FakeCalendar {
  public events = {
    list: async () => ({ data: { items: [] } }),
    insert: async () => ({ data: { id: 'x', htmlLink: 'https://calendar.local/x' } }),
  };
}

describe('openapi route', () => {
  let app: any;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.GOOGLE_CLIENT_ID = 'x';
    process.env.GOOGLE_CLIENT_SECRET = 'y';
    process.env.GOOGLE_REFRESH_TOKEN = 'z';
    process.env.GOOGLE_CALENDAR_ID = 'primary';
    process.env.TZ = 'America/New_York';

    ({ buildServer } = await import('../src/server'));
    app = await buildServer(new FakeCalendar() as unknown as calendar_v3.Calendar);
  });

  afterEach(async () => {
    if (app?.close) await app.close();
  });

  it('serves openapi.yaml', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/yaml');
    expect(res.body).toContain('openapi: 3.1.0');
  });
});
