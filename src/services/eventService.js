'use strict';

/**
 * Push channel for license changes (Server-Sent Events) built on a transactional outbox.
 *
 *  WRITE SIDE  recordEvent(client, …) inserts a row in license_events INSIDE the same
 *              transaction as the license change and issues pg_notify (delivered by
 *              PostgreSQL only if/when that transaction COMMITS). No commit => no event;
 *              commit => event is durable even if every notification is lost.
 *  READ SIDE   EventHub keeps the open SSE connections of THIS server instance and
 *              learns about new events from (a) LISTEN/NOTIFY and (b) a cheap polling
 *              fallback over the outbox table. Both paths feed the same de-duplicated
 *              dispatcher, so it works with several Railway replicas and survives lost
 *              notifications or a dropped LISTEN connection.
 *  REPLAY      A reconnecting client sends its last event id; the missed events of ITS
 *              license are replayed from the table (or a `resync` hint if too many).
 *
 *  The event is only a HINT ("something changed for your license"). It carries no
 *  secrets and no decision; the client then asks /licenses/validate, which stays the
 *  single source of truth.
 */

const crypto = require('crypto');
const { Client } = require('pg');
const { resolveDatabaseUrl } = require('../db/config');
const pool = require('../db/pool');

const CHANNEL = 'license_events';
const num = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const cfg = () => ({
  heartbeatMs: num('LICENSE_EVENTS_HEARTBEAT_MS', 25000),
  maxAgeMs: num('LICENSE_EVENTS_MAX_AGE_MS', 30 * 60 * 1000), // graceful recycle (re-auth + rebalancing)
  pollMs: num('LICENSE_EVENTS_POLL_MS', 5000),
  maxConnections: num('LICENSE_EVENTS_MAX_CONNECTIONS', 5000),
  replayLimit: num('LICENSE_EVENTS_REPLAY_LIMIT', 50),
  retentionDays: num('LICENSE_EVENTS_RETENTION_DAYS', 30),
  retryMs: num('LICENSE_EVENTS_RETRY_MS', 30000),
});

/** Write side - call inside the transaction that changes the license. */
async function recordEvent(client, { licenseId, productId, type }) {
  const r = await client.query(
    `INSERT INTO license_events (license_id, product_id, type) VALUES ($1, $2, $3) RETURNING id`,
    [licenseId, productId, type]
  );
  const id = String(r.rows[0].id);
  // Delivered only on COMMIT (transactional NOTIFY).
  await client.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ id, licenseId, type })]);
  return id;
}

function sseEvent(ev) {
  return `id: ${ev.id}\nevent: license\ndata: ${JSON.stringify({ type: ev.type, id: String(ev.id) })}\n\n`;
}

class EventHub {
  constructor() {
    this.conns = new Map(); // licenseId -> Map(deviceId -> conn)
    this.count = 0;
    this.lastId = 0n;
    this.seen = new Set();
    this.listener = null;
    this.pollTimer = null;
    this.cleanTimer = null;
    this.started = false;
    this.stats = { dispatched: 0, notified: 0, polled: 0, replaced: 0, rejectedFull: 0, listenReconnects: 0 };
  }

  get size() { return this.count; }

  async start() {
    if (this.started) return;
    this.started = true;
    try {
      const r = await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM license_events');
      this.lastId = BigInt(r.rows[0].m);
    } catch (error) {
      // The database was not reachable yet (e.g. the app booted before Postgres on Railway).
      // Without this, `started` stayed true with no listener and no poller: the stream endpoint kept
      // accepting devices and sending heartbeats, but a revoke was NEVER delivered until the next deploy.
      this.started = false;
      this._scheduleStartRetry();
      throw error;
    }
    this._listen();
    const { pollMs } = cfg();
    this.pollTimer = setInterval(() => this._poll().catch((e) => console.error('Event poll failed:', e.message)), pollMs);
    this.pollTimer.unref();
    this.cleanTimer = setInterval(() => this._cleanup().catch(() => {}), 6 * 3600 * 1000);
    this.cleanTimer.unref();
  }

  _scheduleStartRetry() {
    if (this._startRetry) return;
    this._startFailures = (this._startFailures || 0) + 1;
    const base = num('LICENSE_EVENTS_START_RETRY_MS', 5000);
    const delay = Math.min(60000, base * 2 ** Math.min(this._startFailures - 1, 4));
    this._startRetry = setTimeout(() => {
      this._startRetry = null;
      this.start().then(() => { this._startFailures = 0; console.log('Event hub started after retry.'); })
        .catch((e) => console.error('Event hub start retry failed:', e.message));
    }, delay);
    if (this._startRetry.unref) this._startRetry.unref();
  }

  async stop() {
    clearTimeout(this._startRetry); this._startRetry = null;
    this.started = false;
    clearInterval(this.pollTimer); clearInterval(this.cleanTimer);
    this.pollTimer = this.cleanTimer = null;
    clearTimeout(this._listenRetry);
    const l = this.listener; this.listener = null;
    if (l) { l.removeAllListeners(); await l.end().catch(() => {}); }
    for (const byDevice of this.conns.values()) for (const c of byDevice.values()) c.close('shutdown');
  }

  _listen(delay = 0) {
    if (!this.started) return;
    this._listenRetry = setTimeout(async () => {
      if (!this.started) return;
      const c = new Client({ connectionString: resolveDatabaseUrl() });
      c.on('error', () => {});
      try {
        await c.connect();
        c.on('notification', (msg) => {
          try {
            const p = JSON.parse(msg.payload);
            this.stats.notified++;
            this._dispatch({ id: BigInt(p.id), licenseId: p.licenseId, type: p.type });
          } catch (_e) { /* malformed notification: the poller will pick the row up */ }
        });
        c.on('end', () => {
          if (this.listener === c) { this.listener = null; this.stats.listenReconnects++; this._listen(2000 + Math.random() * 3000); }
        });
        await c.query(`LISTEN ${CHANNEL}`);
        this.listener = c;
        // We may have missed notifications while not listening: reconcile from the table.
        await this._poll();
      } catch (e) {
        await c.end().catch(() => {});
        console.error('Event LISTEN connect failed:', e.message);
        this._listen(Math.min(30000, 2000 + Math.random() * 5000));
      }
    }, delay);
    this._listenRetry.unref && this._listenRetry.unref();
  }

  /** Polling fallback: re-reads a short window so late-committing lower ids are not lost. */
  async _poll() {
    const r = await pool.query(
      `SELECT id, license_id, type FROM license_events
        WHERE id > $1 OR created_at > NOW() - INTERVAL '2 minutes'
        ORDER BY id ASC LIMIT 1000`,
      [String(this.lastId)]
    );
    for (const row of r.rows) {
      this.stats.polled++;
      this._dispatch({ id: BigInt(row.id), licenseId: row.license_id, type: row.type });
    }
  }

  async _cleanup() {
    await pool.query(`DELETE FROM license_events WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(cfg().retentionDays)]);
  }

  _dispatch(ev) {
    const key = ev.id.toString();
    if (this.seen.has(key)) return; // dedupe across NOTIFY + poll
    this.seen.add(key);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    if (ev.id > this.lastId) this.lastId = ev.id;
    this.stats.dispatched++;
    const byDevice = this.conns.get(ev.licenseId);
    if (!byDevice) return;
    for (const c of byDevice.values()) c.send(ev);
  }

  /** Registers a connection; a newer connection of the same device replaces the older one. */
  add(licenseId, deviceId, conn) {
    const existing = this.conns.get(licenseId);
    const old = existing && existing.get(deviceId);
    if (old) { this.stats.replaced++; old.close('superseded'); } // may drop the (now empty) license map
    let byDevice = this.conns.get(licenseId);
    if (!byDevice) { byDevice = new Map(); this.conns.set(licenseId, byDevice); }
    byDevice.set(deviceId, conn);
    this.count++;
  }

  remove(licenseId, deviceId, conn) {
    const byDevice = this.conns.get(licenseId);
    if (!byDevice || byDevice.get(deviceId) !== conn) return;
    byDevice.delete(deviceId);
    this.count--;
    if (!byDevice.size) this.conns.delete(licenseId);
  }
}

const hub = new EventHub();

/**
 * POST /api/v1/licenses/events  (Server-Sent Events over POST so the key is never in a URL)
 * body: { licenseKey, productId?, deviceId, lastEventId? }
 * AuthN/Z: the (key, product, device) must correspond to an activation row of that license
 * (active or not: a device that was just reset/revoked must still learn about it). The
 * stream is bound to that ONE license id; events of other licenses are never delivered.
 */
async function handleStream(req, res) {
  const c = cfg();
  const body = req.body || {};
  const licenseKey = typeof body.licenseKey === 'string' ? body.licenseKey.trim() : '';
  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  const productId = typeof body.productId === 'string' && body.productId ? body.productId : 'school-accreditation';
  let lastEventId = null;
  if (body.lastEventId !== undefined && body.lastEventId !== null && /^\d{1,18}$/.test(String(body.lastEventId))) {
    lastEventId = BigInt(String(body.lastEventId));
  }

  if (!licenseKey || !deviceId || licenseKey.length > 255 || deviceId.length > 255) {
    return res.status(401).json({ status: 'unauthorized', message: 'Not authorized for this license.' });
  }

  if (hub.size >= c.maxConnections) {
    hub.stats.rejectedFull++;
    res.set('Retry-After', String(30 + Math.floor(Math.random() * 60)));
    return res.status(503).json({ status: 'busy', message: 'Event channel is at capacity; retry later.' });
  }

  let license;
  try {
    const r = await pool.query(
      `SELECT l.id
         FROM licenses l
         JOIN activations a ON a.license_id = l.id
         JOIN devices d ON d.id = a.device_id AND d.device_id = $3
        WHERE l.license_key = $1 AND l.product_id = $2
        LIMIT 1`,
      [licenseKey, productId, deviceId]
    );
    license = r.rows[0];
  } catch (error) {
    console.error('Event stream auth error:', error.message);
    return res.status(503).json({ status: 'busy', message: 'Temporarily unavailable.' });
  }

  if (!license) {
    // Same answer for "unknown key", "other product" and "device never activated" (no oracle).
    return res.status(401).json({ status: 'unauthorized', message: 'Not authorized for this license.' });
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  req.socket.setKeepAlive(true, 20000);
  req.socket.setTimeout(0);

  let closed = false;
  const conn = {
    send(ev) { if (!closed) res.write(sseEvent({ id: ev.id, type: ev.type })); },
    close(reason) {
      if (closed) return;
      closed = true;
      clearInterval(hb); clearTimeout(life);
      hub.remove(license.id, deviceId, conn);
      try { if (reason) res.write(`event: ${reason}\ndata: {}\n\n`); res.end(); } catch (_e) { /* socket gone */ }
    },
  };
  const hb = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, c.heartbeatMs);
  const life = setTimeout(() => conn.close('reconnect'), c.maxAgeMs * (0.8 + Math.random() * 0.4));
  res.on('close', () => conn.close(null)); // res (not req): req 'close' fires when the request BODY is consumed

  res.write(`retry: ${c.retryMs}\n: connected\n\n`);
  hub.add(license.id, deviceId, conn);

  // Cursor: tells a client that has not seen any event yet where "now" is, so that after a disconnect
  // it can ask for exactly what it missed (without it a never-notified client could not be replayed).
  try {
    const cur = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM license_events WHERE license_id = $1', [license.id])).rows[0].m;
    if (!closed) res.write(`event: hello\ndata: ${JSON.stringify({ cursor: String(cur) })}\n\n`);
  } catch (_e) { /* best effort */ }

  // Replay what this device missed (only events of ITS license).
  if (lastEventId !== null) {
    try {
      const r = await pool.query(
        `SELECT id, type FROM license_events
          WHERE license_id = $1 AND id > $2 AND created_at > NOW() - ($4 || ' days')::interval
          ORDER BY id ASC LIMIT $3`,
        [license.id, String(lastEventId), c.replayLimit + 1, String(c.retentionDays)]
      );
      const maxId = (await pool.query('SELECT COALESCE(MAX(id), 0) AS m FROM license_events')).rows[0].m;
      if (r.rows.length > c.replayLimit || BigInt(maxId) < lastEventId) { // too many missed, or the log was restored to an older point
        res.write('event: resync\ndata: {}\n\n');
      } else {
        for (const row of r.rows) conn.send({ id: row.id, type: row.type });
      }
    } catch (error) {
      console.error('Event replay error:', error.message);
      conn.send({ id: lastEventId, type: 'license.updated' }); // degrade to "please re-validate"
    }
  }
}

module.exports = { recordEvent, handleStream, hub, EventHub, cfg };
