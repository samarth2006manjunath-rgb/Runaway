import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_CALENDAR_SCOPE, GoogleCalendarClient, exchangeGoogleCode, googleAuthorizationUrl } from '../lib/google-calendar.js';

test('constructs a read-only Google authorization URL', () => {
  const url = new URL(googleAuthorizationUrl({ clientId: 'client-id', redirectUri: 'https://runway.example/api/google-calendar/callback', state: 'state-123' }));
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), GOOGLE_CALENDAR_SCOPE);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('state'), 'state-123');
});

test('exchanges a Google authorization code server-side', async () => {
  const token = await exchangeGoogleCode({
    clientId: 'client-id', clientSecret: 'secret', code: 'code', redirectUri: 'https://runway.example/callback',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(options.method, 'POST');
      assert.match(String(options.body), /client_secret=secret/);
      return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }) };
    }
  });
  assert.equal(token.accessToken, 'access');
  assert.equal(token.refreshToken, 'refresh');
});

test('syncs selected calendars and normalizes events', async () => {
  const responses = [
    { items: [{ id: 'primary@example.com', summary: 'School', selected: true, primary: true, backgroundColor: '#4285f4' }] },
    { items: [{ id: 'event-1', summary: 'ECON lecture', start: { dateTime: '2026-09-01T10:00:00-04:00' }, end: { dateTime: '2026-09-01T11:00:00-04:00' } }] }
  ];
  const client = new GoogleCalendarClient({
    connection: { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 },
    clientId: 'client-id', clientSecret: 'secret', saveConnection: async () => {},
    fetchImpl: async () => ({ ok: true, json: async () => responses.shift() })
  });
  const snapshot = await client.sync(new Date('2026-09-01T12:00:00Z'));
  assert.equal(snapshot.calendars.length, 1);
  assert.equal(snapshot.events[0].title, 'ECON lecture');
  assert.equal(snapshot.events[0].calendar, 'School');
});
