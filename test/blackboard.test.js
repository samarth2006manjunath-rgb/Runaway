import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizationUrl, exchangeCode, normalizeLearnUrl } from '../lib/blackboard.js';

test('normalizes a Blackboard hostname', () => {
  assert.equal(normalizeLearnUrl('learn.example.edu/'), 'https://learn.example.edu');
  assert.throws(() => normalizeLearnUrl('http://learn.example.edu'), /HTTPS/);
  assert.throws(() => normalizeLearnUrl('https://user:pass@example.edu'), /hostname/);
  assert.throws(() => normalizeLearnUrl('https://127.0.0.1'), /public/);
});

test('constructs Blackboard authorization-code URL', () => {
  const url = new URL(authorizationUrl({
    learnUrl: 'https://learn.example.edu',
    clientId: 'app-key',
    redirectUri: 'https://runway.example/api/blackboard/callback',
    state: 'random-state'
  }));
  assert.equal(url.pathname, '/learn/api/public/v1/oauth2/authorizationcode');
  assert.equal(url.searchParams.get('client_id'), 'app-key');
  assert.equal(url.searchParams.get('state'), 'random-state');
});

test('exchanges an authorization code without exposing the secret in the body', async () => {
  let request;
  const result = await exchangeCode({
    learnUrl: 'https://learn.example.edu', clientId: 'key', clientSecret: 'secret', code: 'code',
    redirectUri: 'https://runway.example/api/blackboard/callback',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    }
  });
  assert.equal(result.accessToken, 'token');
  assert.match(request.options.headers.authorization, /^Basic /);
  assert.doesNotMatch(String(request.options.body), /secret/);
});
