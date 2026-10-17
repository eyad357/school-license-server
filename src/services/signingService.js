'use strict';

// Asymmetric (Ed25519) license signatures for offline verification by clients.
//
//   * The PRIVATE key lives only in the server environment
//     (LICENSE_SIGNING_PRIVATE_KEY, PEM). It never leaves the server and is
//     never written to the database, logs or the client.
//   * Clients embed only the PUBLIC key(s) and verify the signature locally.
//   * Entirely OPTIONAL: when no private key is configured, responses are
//     byte-for-byte what they were before (no "signedLicense" field), so
//     clients that predate this feature are unaffected.
//   * A signing failure never breaks activation/validation.
//
// Signed document (what the client verifies):
//   signedLicense = { alg:'Ed25519', kid, payload:<base64url JSON>, signature:<base64url> }
//   payload = { v:1, typ:'license', productId, licenseKey, deviceId, status:'active',
//               expiresAt:<ISO|null>, activationRef, issuedAt:<ISO> }
// It is bound to productId + deviceId, so it is useless on another device or
// in another program.

const crypto = require('crypto');

let cached; // undefined = not loaded; null = disabled; {key,kid} = enabled

function load() {
  if (cached !== undefined) return cached;

  const raw = process.env.LICENSE_SIGNING_PRIVATE_KEY;

  if (!raw) {
    cached = null;
    return cached;
  }

  try {
    const pem = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
    const key = crypto.createPrivateKey(pem);

    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('LICENSE_SIGNING_PRIVATE_KEY must be an Ed25519 key');
    }

    cached = { key, kid: process.env.LICENSE_SIGNING_KEY_ID || 'k1' };
  } catch (error) {
    // Do not print the key. Signing is simply disabled.
    console.error('License signing disabled:', error.message);
    cached = null;
  }

  return cached;
}

/** For tests: forget the cached key so env changes take effect. */
function reset() {
  cached = undefined;
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Returns a signedLicense object or null (signing disabled / failed).
 */
function signLicense({ productId, licenseKey, deviceId, expiresAt, activationRef }) {
  const cfg = load();
  if (!cfg) return null;

  try {
    const payload = {
      v: 1,
      typ: 'license',
      productId,
      licenseKey: String(licenseKey).trim(),
      deviceId,
      status: 'active',
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      activationRef: activationRef || null,
      issuedAt: new Date().toISOString(),
    };
    const payloadB64 = b64u(JSON.stringify(payload));
    const signature = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), cfg.key);

    return { alg: 'Ed25519', kid: cfg.kid, payload: payloadB64, signature: b64u(signature) };
  } catch (error) {
    console.error('License signing failed:', error.message);
    return null;
  }
}

/** Adds signedLicense to an ACTIVE result when signing is enabled. */
function withSignature(result, ctx) {
  const signed = signLicense({ ...ctx, expiresAt: result.expiresAt, activationRef: result.activationRef });
  return signed ? { ...result, signedLicense: signed } : result;
}

module.exports = { signLicense, withSignature, reset };
