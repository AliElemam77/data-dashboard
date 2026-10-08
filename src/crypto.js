import { SALT, IV, ITER, DATA } from './data.js';

export const b2u = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const u2b = (u) => btoa(String.fromCharCode(...u));

/**
 * Decrypt the leads database using the Super Admin master password.
 * @param {string} pw Master password
 * @returns {Promise<{ rows: Array<any>, nc: number }>} Decrypted database object
 */
export async function decryptAll(pw) {
  if (!pw) throw new Error('الرجاء إدخال كلمة المرور');
  
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: b2u(SALT),
      iterations: ITER,
      hash: 'SHA-256',
    },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b2u(IV) },
    key,
    b2u(DATA)
  );
  
  const decompressedText = await new Response(
    new Blob([decryptedBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).text();
  
  return JSON.parse(decompressedText);
}

/**
 * Hash password with PBKDF2 for user accounts
 */
export async function hpw(pw, salt, it = 150000) {
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pw),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: it, hash: 'SHA-256' },
    km,
    256
  );
  return u2b(new Uint8Array(bits));
}

/**
 * Create salt and hash for a new user password
 */
export async function mkCred(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const it = 150000;
  return {
    salt: u2b(salt),
    it,
    hash: await hpw(pw, salt, it)
  };
}
