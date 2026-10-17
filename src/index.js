'use strict';

require('dotenv').config();
const path = require('path');
const licenseRoutes = require('./routes/licenseRoutes');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { parseTrustProxy } = require('./lib/trustProxy');
const pool = require('./db/pool');
const adminRoutes = require('./routes/adminRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const adminCustomerRoutes = require('./routes/adminCustomerRoutes');
const { handleStream, hub } = require('./services/eventService');
const app = express();
// Default 1 = exactly one reverse proxy (Railway) in front, as before. Set TRUST_PROXY=false when the
// service is reachable directly; see src/lib/trustProxy.js and docs/H/10-trust-proxy-and-dependency-security.md.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

app.use('/admin', express.static(
  path.join(__dirname, 'admin', 'public')
));

app.get('/admin', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'admin', 'public', 'index.html')
  );
});

app.use(helmet());
const globalJsonParser = express.json({
  limit: '50kb',
  // Keep the raw bytes around so the MyFatoorah webhook handler can verify
  // the HMAC signature over the exact payload received. This does not
  // change parsing behavior for any other route.
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
});

// Bulk license creation and export accept bodies larger than 50kb (up to 1000
// names / ids). Those two admin routes parse their own body AFTER admin
// authentication (see adminCustomerRoutes.js), so everything else keeps the
// exact same 50kb parser as before.
const LARGE_BODY_PATHS = new Set([
  '/api/v1/admin/licenses/bulk',
  '/api/v1/admin/export',
]);

app.use((req, res, next) => {
  if (LARGE_BODY_PATHS.has(req.path)) {
    return next();
  }

  return globalJsonParser(req, res, next);
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
// Push channel (SSE). Registered before the license router; same /api/ rate limit applies.
app.post('/api/v1/licenses/events', handleStream);
app.use('/api/v1/licenses', licenseRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/admin', adminCustomerRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.get('/health', async (_req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS time');

    res.json({
      success: true,
      service: 'school-license-server',
      status: 'ok',
      database: 'connected',
      time: result.rows[0].time,
    });
  } catch (error) {
    console.error('Database health check failed:', error.message);

    res.status(503).json({
      success: false,
      service: 'school-license-server',
      status: 'database_unavailable',
    });
  }
});

const PORT = Number(process.env.PORT || 3100);

// Only start listening when run directly (node src/index.js), so tests can
// import the app without opening a port.
if (require.main === module) {
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`License Server running on port ${PORT}`);
  });

  // Push channel hub (LISTEN/NOTIFY + outbox poller). A failure here must never stop the
  // license API: clients simply fall back to their periodic validation.
  hub.start().catch((error) => console.error('Event hub failed to start:', error.message));

  // Railway sends SIGTERM on every deploy: end the open streams so clients reconnect
  // (with jitter) to the new instance instead of waiting for a timeout.
  process.on('SIGTERM', async () => {
    await hub.stop().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  });
}

module.exports = app;
