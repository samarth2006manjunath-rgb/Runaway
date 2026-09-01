import { isIP } from 'node:net';

const API_ROOT = '/learn/api/public/v1';

export function normalizeLearnUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter your school Blackboard hostname');
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('Blackboard must use HTTPS');
  }
  if (isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) {
    throw new Error('Enter a public Blackboard Learn hostname');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter only the Blackboard hostname');
  return url.origin;
}

export function authorizationUrl({ learnUrl, clientId, redirectUri, state }) {
  const url = new URL(`${learnUrl}${API_ROOT}/oauth2/authorizationcode`);
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    response_type: 'code',
    client_id: clientId,
    scope: '*',
    state
  }).toString();
  return url.toString();
}

export async function exchangeCode({ learnUrl, clientId, clientSecret, code, redirectUri, fetchImpl = fetch }) {
  return tokenRequest({
    learnUrl, clientId, clientSecret, fetchImpl,
    body: { grant_type: 'authorization_code', code, redirect_uri: redirectUri }
  });
}

export async function refreshAccessToken({ connection, clientId, clientSecret, fetchImpl = fetch }) {
  if (!connection.refreshToken) throw new Error('Blackboard authorization expired; sign in again');
  return tokenRequest({
    learnUrl: connection.learnUrl, clientId, clientSecret, fetchImpl,
    body: { grant_type: 'refresh_token', refresh_token: connection.refreshToken }
  });
}

async function tokenRequest({ learnUrl, clientId, clientSecret, body, fetchImpl }) {
  const response = await fetchImpl(`${learnUrl}${API_ROOT}/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams(body)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error_description || json.message || `Blackboard token request failed (${response.status})`);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresAt: Date.now() + Math.max(30, Number(json.expires_in || 3600)) * 1000,
    scope: json.scope || '*'
  };
}

export class BlackboardClient {
  constructor({ connection, saveConnection, clientId, clientSecret, fetchImpl = fetch }) {
    this.connection = connection;
    this.saveConnection = saveConnection;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
  }

  async ensureToken() {
    if (this.connection.expiresAt > Date.now() + 60_000) return;
    const refreshed = await refreshAccessToken({
      connection: this.connection,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      fetchImpl: this.fetch
    });
    Object.assign(this.connection, refreshed, {
      refreshToken: refreshed.refreshToken || this.connection.refreshToken
    });
    await this.saveConnection(this.connection);
  }

  async request(path) {
    await this.ensureToken();
    const response = await this.fetch(`${this.connection.learnUrl}${API_ROOT}${path}`, {
      headers: { authorization: `Bearer ${this.connection.accessToken}`, accept: 'application/json' }
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.message || `Blackboard API request failed (${response.status})`);
    return json;
  }

  async all(path, limit = 100) {
    const results = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}limit=${limit}`;
    while (next) {
      const page = await this.request(next.replace(`${this.connection.learnUrl}${API_ROOT}`, ''));
      results.push(...(page.results || []));
      next = page.paging?.nextPage || null;
    }
    return results;
  }

  async sync() {
    const [user, memberships] = await Promise.all([
      this.request('/users/me'),
      this.all('/users/me/courses')
    ]);
    const courses = [];
    for (const membership of memberships) {
      const courseId = membership.courseId || membership.course?.id;
      if (!courseId) continue;
      const encoded = encodeURIComponent(courseId);
      const [course, content, announcements, columns] = await Promise.all([
        this.request(`/courses/${encoded}`),
        this.all(`/courses/${encoded}/contents`).catch(() => []),
        this.all(`/courses/${encoded}/announcements`).catch(() => []),
        this.all(`/courses/${encoded}/gradebook/columns`).catch(() => [])
      ]);
      const grades = [];
      for (const column of columns) {
        if (!column.id) continue;
        const grade = await this.request(`/courses/${encoded}/gradebook/columns/${encodeURIComponent(column.id)}/users/me`).catch(() => null);
        if (grade) grades.push({ column, grade });
      }
      courses.push({ course, membership, content, announcements, grades });
    }
    return { user, courses, syncedAt: new Date().toISOString() };
  }
}
