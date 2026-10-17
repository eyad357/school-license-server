'use strict';

// Reads the TRUST_PROXY environment variable for Express' "trust proxy" setting.
//
// Why this matters: req.ip (used by every rate limiter, including the admin login limiter) is taken from
// X-Forwarded-For. If too many addresses are trusted, a client can write its own X-Forwarded-For and
// pick any "IP" it likes, which defeats the limits.
//
//   unset              -> 1   exactly ONE reverse proxy in front (Railway's edge). Same as before.
//   0 / false          -> no proxy in front: X-Forwarded-For is ignored. Use this when the service is
//                         reachable directly (local runs, tests, any host without a proxy).
//   2, 3 ...           -> that many proxy hops (e.g. CDN + Railway edge).
//   "10.0.0.0/8,..."   -> trust only those proxy addresses/ranges (proxy-addr syntax).
//   true               -> REFUSED: "trust everybody" lets any client forge its address.
//
// Ranges that would trust (nearly) every address are refused too, including IPv6 prefixes shorter than /96
// (they cover ::ffff:0:0/96 and therefore every IPv4 address; this is the shape that triggered the
// proxy-addr < 2.0.8 advisory GHSA-jqcg-44mw-7w3h).

const net = require('net');
const proxyaddr = require('proxy-addr');

const MAX_HOPS = 5;

function fail(message) {
  throw new Error(`TRUST_PROXY: ${message}`);
}

function checkEntry(entry) {
  const named = ['loopback', 'linklocal', 'uniquelocal'];
  if (named.includes(entry)) return;

  const [addr, prefixRaw] = entry.split('/');
  const family = net.isIP(addr);
  if (!family) fail(`"${entry}" is not an IP address, CIDR range or one of ${named.join('/')}.`);

  if (prefixRaw !== undefined) {
    if (!/^\d{1,3}$/.test(prefixRaw)) fail(`"${entry}" has an invalid prefix length.`);
    const prefix = Number(prefixRaw);
    if (family === 4 && (prefix > 32 || prefix < 8)) fail(`"${entry}" trusts too many addresses (IPv4 prefix must be 8..32).`);
    if (family === 6 && (prefix > 128 || prefix < 96)) fail(`"${entry}" trusts too many addresses (IPv6 prefix must be 96..128).`);
  }

  try {
    proxyaddr.compile([entry]);
  } catch (error) {
    fail(`"${entry}" is not accepted (${error.message}).`);
  }
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;

  const text = String(raw).trim();
  const lower = text.toLowerCase();

  if (lower === 'false') return false;
  if (lower === 'true') fail('"true" would trust every client-supplied X-Forwarded-For. Use a hop count (1) or an explicit proxy list.');

  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops > MAX_HOPS) fail(`hop count ${hops} is unreasonably large (max ${MAX_HOPS}).`);
    return hops === 0 ? false : hops;
  }

  const entries = text.split(',').map((item) => item.trim()).filter(Boolean);
  if (!entries.length) fail('empty list.');
  entries.forEach(checkEntry);
  return entries;
}

module.exports = { parseTrustProxy };
