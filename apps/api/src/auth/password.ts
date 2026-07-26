import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;

  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (expected.length !== KEY_LENGTH) return false;
    const actual = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
