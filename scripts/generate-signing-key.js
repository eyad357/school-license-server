'use strict';

// Generates an Ed25519 key pair for license signing.
//   node scripts/generate-signing-key.js [output-dir]
// Writes  license-signing-private.pem  (keep SECRET: put it in the Railway
// variable LICENSE_SIGNING_PRIVATE_KEY, never in git / the Windows app / a ZIP)
// and     license-signing-public.pem   (embedded in the Windows app).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(dir, { recursive: true });

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const priv = path.join(dir, 'license-signing-private.pem');
const pub = path.join(dir, 'license-signing-public.pem');

fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));

console.log(`Private key (SECRET): ${priv}`);
console.log(`Public key:           ${pub}`);
console.log('Set LICENSE_SIGNING_PRIVATE_KEY to the private PEM (newlines may be written as \\n).');
