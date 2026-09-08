'use strict';

require('dotenv').config();
const path = require('path');
const licenseRoutes = require('./routes/licenseRoutes');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pool = require('./db/pool');
const adminRoutes = require('./routes/adminRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const app = express();

app.use('/admin', express.static(
  path.join(__dirname, 'admin', 'public')
));

app.get('/admin', (_req, res) => {
  res.sendFile(
    path.join(__dirname, 'admin', 'public', 'index.html')
  );
});

app.use(helmet());
app.use(express.json({
  limit: '50kb',
  // Keep the raw bytes around so the MyFatoorah webhook handler can verify
  // the HMAC signature over the exact payload received. This does not
  // change parsing behavior for any other route.
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);
app.use('/api/v1/licenses', licenseRoutes);
app.use('/api/v1/admin', adminRoutes);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`License Server running on port ${PORT}`);
});