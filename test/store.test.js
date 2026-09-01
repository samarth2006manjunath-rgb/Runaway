import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectionStore } from '../lib/store.js';

test('encrypts connection tokens at rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runway-store-'));
  const file = join(dir, 'connection.json');
  const store = new ConnectionStore(file, 'a'.repeat(64));
  await store.write({ accessToken: 'very-secret-token', learnUrl: 'https://learn.example.edu' });
  const disk = await readFile(file, 'utf8');
  assert.doesNotMatch(disk, /very-secret-token/);
  assert.equal((await store.read()).accessToken, 'very-secret-token');
});
