import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlackboardClient, authorizationUrl, exchangeCode, normalizeLearnUrl } from './lib/blackboard.js';
import { GoogleCalendarClient, exchangeGoogleCode, googleAuthorizationUrl } from './lib/google-calendar.js';
import { ConnectionStore } from './lib/store.js';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const appOrigin = (process.env.APP_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
const clientId = process.env.BLACKBOARD_CLIENT_ID;
const clientSecret = process.env.BLACKBOARD_CLIENT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
if (!encryptionKey) {
  console.error('Missing TOKEN_ENCRYPTION_KEY');
  process.exit(1);
}
const store = new ConnectionStore(join(root, 'data', 'connection.enc.json'), encryptionKey);
const googleStore = new ConnectionStore(join(root, 'data', 'google-calendar.enc.json'), encryptionKey);
const pendingStates = new Map();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function publicConnection(connection) {
  if (!connection?.accessToken) return { connected: false };
  return {
    connected: true,
    learnUrl: connection.learnUrl,
    user: connection.user || null,
    courseCount: connection.snapshot?.courses?.length || 0,
    courses: (connection.snapshot?.courses || []).map(item => ({
      id: item.course?.id,
      courseId: item.course?.courseId || item.course?.externalId || item.course?.id,
      name: item.course?.name || 'Untitled course',
      itemCount: item.content?.length || 0
    })),
    syncedAt: connection.snapshot?.syncedAt || null,
    expired: connection.expiresAt <= Date.now() && !connection.refreshToken
  };
}

function client(connection) {
  return new BlackboardClient({
    connection,
    clientId,
    clientSecret,
    saveConnection: value => store.write(value)
  });
}

function googleClient(connection) {
  return new GoogleCalendarClient({ connection, clientId: googleClientId, clientSecret: googleClientSecret, saveConnection: value => googleStore.write(value) });
}

function publicGoogleConnection(connection) {
  if (!connection?.accessToken) return { connected: false, configured: Boolean(googleClientId && googleClientSecret) };
  return {
    connected: true,
    configured: true,
    calendarCount: connection.snapshot?.calendars?.length || 0,
    eventCount: connection.snapshot?.events?.length || 0,
    syncedAt: connection.snapshot?.syncedAt || null,
    expired: connection.expiresAt <= Date.now() && !connection.refreshToken
  };
}

async function api(req, res, url) {
  if (url.pathname.startsWith('/api/google-calendar/') && (!googleClientId || !googleClientSecret)) {
    return json(res, 503, { error: 'Google Calendar OAuth is not configured on this server' });
  }
  if (req.method === 'GET' && url.pathname === '/api/google-calendar/status') {
    return json(res, 200, publicGoogleConnection(await googleStore.read()));
  }
  if (req.method === 'POST' && url.pathname === '/api/google-calendar/connect') {
    const state = randomBytes(32).toString('hex');
    pendingStates.set(`google:${createHash('sha256').update(state).digest('hex')}`, { expiresAt: Date.now() + 10 * 60_000 });
    const redirectUri = `${appOrigin}/api/google-calendar/callback`;
    return json(res, 200, { authorizationUrl: googleAuthorizationUrl({ clientId: googleClientId, redirectUri, state }) });
  }
  if (req.method === 'GET' && url.pathname === '/api/google-calendar/callback') {
    const state = url.searchParams.get('state') || '';
    const key = `google:${createHash('sha256').update(state).digest('hex')}`;
    const pending = pendingStates.get(key);
    pendingStates.delete(key);
    if (!pending || pending.expiresAt < Date.now() || !url.searchParams.get('code')) {
      res.writeHead(302, { location: '/?googleCalendar=error' }); return res.end();
    }
    const tokens = await exchangeGoogleCode({ clientId: googleClientId, clientSecret: googleClientSecret,
      code: url.searchParams.get('code'), redirectUri: `${appOrigin}/api/google-calendar/callback` });
    const connection = { ...tokens, connectedAt: new Date().toISOString() };
    connection.snapshot = await googleClient(connection).sync();
    await googleStore.write(connection);
    res.writeHead(302, { location: '/?googleCalendar=connected' }); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/google-calendar/sync') {
    const connection = await googleStore.read();
    if (!connection?.accessToken) return json(res, 409, { error: 'Google Calendar is not connected' });
    connection.snapshot = await googleClient(connection).sync();
    await googleStore.write(connection);
    return json(res, 200, { ...publicGoogleConnection(connection), snapshot: connection.snapshot });
  }
  if (req.method === 'GET' && url.pathname === '/api/google-calendar/data') {
    const connection = await googleStore.read();
    if (!connection?.accessToken) return json(res, 409, { error: 'Google Calendar is not connected' });
    return json(res, 200, connection.snapshot || { calendars: [], events: [] });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/google-calendar/connection') {
    await googleStore.clear();
    return json(res, 200, { connected: false });
  }
  if (req.method === 'GET' && url.pathname === '/api/blackboard/status') {
    if (!clientId || !clientSecret) return json(res, 200, { connected: false, configured: false });
    return json(res, 200, publicConnection(await store.read()));
  }
  if (req.method === 'POST' && url.pathname === '/api/blackboard/connect') {
    if (!clientId || !clientSecret) return json(res, 503, { error: 'Blackboard OAuth is not configured on this server' });
    const input = await body(req);
    const learnUrl = normalizeLearnUrl(input.learnUrl);
    const state = randomBytes(32).toString('hex');
    pendingStates.set(createHash('sha256').update(state).digest('hex'), { learnUrl, expiresAt: Date.now() + 10 * 60_000 });
    const redirectUri = `${appOrigin}/api/blackboard/callback`;
    return json(res, 200, { authorizationUrl: authorizationUrl({ learnUrl, clientId, redirectUri, state }) });
  }
  if (req.method === 'GET' && url.pathname === '/api/blackboard/callback') {
    const state = url.searchParams.get('state') || '';
    const key = createHash('sha256').update(state).digest('hex');
    const pending = pendingStates.get(key);
    pendingStates.delete(key);
    if (!pending || pending.expiresAt < Date.now() || !url.searchParams.get('code')) {
      res.writeHead(302, { location: '/?blackboard=error' }); return res.end();
    }
    const tokens = await exchangeCode({
      learnUrl: pending.learnUrl,
      clientId,
      clientSecret,
      code: url.searchParams.get('code'),
      redirectUri: `${appOrigin}/api/blackboard/callback`
    });
    const connection = { learnUrl: pending.learnUrl, ...tokens, connectedAt: new Date().toISOString() };
    const snapshot = await client(connection).sync();
    connection.user = snapshot.user;
    connection.snapshot = snapshot;
    await store.write(connection);
    res.writeHead(302, { location: '/?blackboard=connected' }); return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/blackboard/sync') {
    const connection = await store.read();
    if (!connection?.accessToken) return json(res, 409, { error: 'Blackboard is not connected' });
    const snapshot = await client(connection).sync();
    connection.user = snapshot.user;
    connection.snapshot = snapshot;
    await store.write(connection);
    return json(res, 200, { ...publicConnection(connection), snapshot });
  }
  if (req.method === 'GET' && url.pathname === '/api/blackboard/data') {
    const connection = await store.read();
    if (!connection?.accessToken) return json(res, 409, { error: 'Blackboard is not connected' });
    return json(res, 200, connection.snapshot || { courses: [] });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/blackboard/connection') {
    await store.clear();
    return json(res, 200, { connected: false });
  }
  return json(res, 404, { error: 'Not found' });
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jsx': 'text/javascript; charset=utf-8' };
const server = (await import('node:http')).createServer(async (req, res) => {
  try {
    const url = new URL(req.url, appOrigin);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = resolve(root, requested);
    let fileInfo = null;
    try { fileInfo = await stat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!file.startsWith(resolve(root) + '/') || !fileInfo?.isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: error.message || 'Unexpected server error' });
  }
});

server.listen(port, () => console.log(`Runway listening on ${appOrigin}`));
