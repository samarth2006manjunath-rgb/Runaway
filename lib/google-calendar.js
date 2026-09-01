const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://www.googleapis.com/calendar/v3';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

export function googleAuthorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CALENDAR_SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state
  }).toString();
  return url.toString();
}

export async function exchangeGoogleCode({ clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  return googleTokenRequest({
    fetchImpl,
    body: { client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }
  });
}

export async function refreshGoogleToken({ connection, clientId, clientSecret, fetchImpl = fetch }) {
  if (!connection.refreshToken) throw new Error('Google Calendar authorization expired; connect it again');
  return googleTokenRequest({
    fetchImpl,
    body: { client_id: clientId, client_secret: clientSecret, refresh_token: connection.refreshToken, grant_type: 'refresh_token' }
  });
}

async function googleTokenRequest({ body, fetchImpl }) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error_description || json.error || `Google token request failed (${response.status})`);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: Date.now() + Math.max(30, Number(json.expires_in || 3600)) * 1000,
    scope: json.scope || GOOGLE_CALENDAR_SCOPE
  };
}

export class GoogleCalendarClient {
  constructor({ connection, saveConnection, clientId, clientSecret, fetchImpl = fetch }) {
    this.connection = connection;
    this.saveConnection = saveConnection;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
  }

  async ensureToken() {
    if (this.connection.expiresAt > Date.now() + 60_000) return;
    const refreshed = await refreshGoogleToken({
      connection: this.connection, clientId: this.clientId, clientSecret: this.clientSecret, fetchImpl: this.fetch
    });
    Object.assign(this.connection, refreshed, { refreshToken: refreshed.refreshToken || this.connection.refreshToken });
    await this.saveConnection(this.connection);
  }

  async request(path) {
    await this.ensureToken();
    const response = await this.fetch(`${API_URL}${path}`, {
      headers: { authorization: `Bearer ${this.connection.accessToken}`, accept: 'application/json' }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error?.message || `Google Calendar request failed (${response.status})`);
    return json;
  }

  async sync(now = new Date()) {
    const calendarsPage = await this.request('/users/me/calendarList?minAccessRole=reader&showHidden=false');
    const calendars = (calendarsPage.items || []).filter(calendar => calendar.selected !== false);
    const timeMin = new Date(now.getTime() - 14 * 86400_000).toISOString();
    const timeMax = new Date(now.getTime() + 90 * 86400_000).toISOString();
    const events = [];
    for (const calendar of calendars) {
      let pageToken = '';
      do {
        const query = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin, timeMax, maxResults: '2500' });
        if (pageToken) query.set('pageToken', pageToken);
        const page = await this.request(`/calendars/${encodeURIComponent(calendar.id)}/events?${query}`);
        for (const event of page.items || []) {
          if (event.status === 'cancelled' || (!event.start?.dateTime && !event.start?.date)) continue;
          events.push({
            id: `${calendar.id}:${event.id}`,
            calendarId: calendar.id,
            calendar: calendar.summary || 'Google Calendar',
            color: calendar.backgroundColor || '#4285f4',
            title: event.summary || '(No title)',
            location: event.location || '',
            start: event.start.dateTime || event.start.date,
            end: event.end?.dateTime || event.end?.date || null,
            allDay: Boolean(event.start.date)
          });
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken);
    }
    return { calendars: calendars.map(({ id, summary, primary, backgroundColor }) => ({ id, summary, primary: !!primary, color: backgroundColor || '#4285f4' })), events, syncedAt: new Date().toISOString() };
  }
}
