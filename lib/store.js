import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class ConnectionStore {
  constructor(file, keyHex) {
    if (!/^[a-f\d]{64}$/i.test(keyHex || '')) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
    }
    this.file = file;
    this.key = Buffer.from(keyHex, 'hex');
  }

  async read() {
    try {
      const envelope = JSON.parse(await readFile(this.file, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const clear = Buffer.concat([
        decipher.update(Buffer.from(envelope.payload, 'base64')),
        decipher.final()
      ]);
      return JSON.parse(clear.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(value) {
    await mkdir(dirname(this.file), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const envelope = JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      payload: payload.toString('base64')
    });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, envelope, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async clear() {
    await this.write({ disconnectedAt: new Date().toISOString() });
  }
}
