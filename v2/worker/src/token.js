// Access tokens for the song server. A player sends the access code once and gets back a
// token, "v1.<expiry in seconds>.<signature>", signed with SIGNING_KEY (HMAC-SHA256). Every
// song URL carries the token, so an <audio> element can play a URL directly, and a shared
// link stops working when the token expires.

const encoder = new TextEncoder();

function base64url(bytes) {
  let text = '';
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text) {
  const plain = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(plain, (c) => c.charCodeAt(0));
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function makeToken(secret, expiresAtSeconds) {
  const payload = `v1.${expiresAtSeconds}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload));
  return `${payload}.${base64url(signature)}`;
}

/** True when the token was signed with `secret` and has not expired. */
export async function checkToken(secret, token, nowSeconds) {
  if (!secret || typeof token !== 'string') return false;
  const match = token.match(/^(v1\.(\d{1,12}))\.([A-Za-z0-9_-]{43})$/);
  if (!match || Number(match[2]) <= nowSeconds) return false;
  try {
    // verify() compares in constant time.
    return await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromBase64url(match[3]), encoder.encode(match[1]));
  } catch {
    return false;
  }
}

/** Access codes are typed on phones: case, spaces and dashes don't matter. */
export function normalizeCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Compares two secrets without leaking, through timing, how much of a guess was right. */
export async function sameSecret(expected, given) {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([expected, given].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
