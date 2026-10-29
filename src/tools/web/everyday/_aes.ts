/**
 * AES-256-GCM with a PBKDF2-SHA256 key, through Node's WebCrypto: the same primitives and parameters the website
 * uses in the browser (text-encrypt, file-encrypt, stego-image), so data moves between them both ways.
 * The password is NFC-normalised and UTF-8 encoded before key derivation, exactly like the website.
 */
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const te = new TextEncoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function randomBytes(n: number): Bytes {
  const b = new Uint8Array(n);
  webcrypto.getRandomValues(b);
  return b;
}

export async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await subtle.importKey('raw', te.encode(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as Bytes, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function gcmEncrypt(key: webcrypto.CryptoKey, iv: Uint8Array, aad: Uint8Array, plain: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: iv as Bytes, additionalData: aad as Bytes, tagLength: 128 }, key, plain as Bytes));
}

/** Throws (any error) when the key is wrong or the data/AAD was changed. */
export async function gcmDecrypt(key: webcrypto.CryptoKey, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: iv as Bytes, additionalData: aad as Bytes, tagLength: 128 }, key, ct as Bytes));
}

export function concat(parts: Uint8Array[]): Bytes {
  const o = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { o.set(p, off); off += p.length; }
  return o;
}
