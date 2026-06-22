'use strict';

// Authentication primitives — zero runtime deps, all on Node's builtin `crypto`.
//
//  - Password hashing: scrypt (memory-hard KDF) with a per-user random salt.
//    Stored as hex `hash` + hex `salt`; verification is constant-time.
//  - Session cookies: an opaque random token, HMAC-signed so a tampered/forged
//    cookie is rejected before any DB lookup. The signing secret is persisted in
//    the DB `meta` table (see db.seedSessionSecret) so it survives a deploy and
//    every running instance signs/verifies consistently.
//  - One-shot tokens (email-verify / password-reset): plain random hex.

const crypto = require('crypto');

const SCRYPT_KEYLEN = 64;
// cost params: N=16384 (2^14), r=8, p=1 — ~tens of ms per hash, standard for a
// login path. maxmem must be raised above the default or scrypt throws at this N.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Hash a plaintext password. Returns { hash, salt } as hex strings. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return { hash: derived.toString('hex'), salt: salt.toString('hex') };
}

/** Constant-time verify of a plaintext password against a stored hash+salt. */
function verifyPassword(password, hashHex, saltHex) {
  if (!hashHex || !saltHex) return false;
  let salt;
  let stored;
  try {
    salt = Buffer.from(saltHex, 'hex');
    stored = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, stored.length, SCRYPT_OPTS);
  } catch {
    return false;
  }
  return derived.length === stored.length && crypto.timingSafeEqual(derived, stored);
}

/** Random opaque token (hex). Used for session ids and one-shot email tokens. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** HMAC-SHA256 of `value` with `secret`, hex. */
function hmac(value, secret) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/**
 * Sign a cookie value: `value.signature`. The value itself is opaque (a session
 * token), the signature lets us reject forged/tampered cookies cheaply.
 */
function signCookie(value, secret) {
  return `${value}.${hmac(value, secret)}`;
}

/**
 * Verify and unwrap a signed cookie. Returns the original value, or null if the
 * signature is missing/invalid. Comparison is constant-time.
 */
function unsignCookie(signed, secret) {
  if (!signed || typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = hmac(value, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

module.exports = {
  hashPassword,
  verifyPassword,
  randomToken,
  signCookie,
  unsignCookie,
};
