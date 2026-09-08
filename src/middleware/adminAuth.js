'use strict';

const jwt = require('jsonwebtoken');

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';

  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'unauthorized',
      message: 'Admin authentication required.',
    });
  }

  const token = auth.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (payload.role !== 'admin') {
      return res.status(403).json({
        status: 'forbidden',
        message: 'Admin access required.',
      });
    }

    req.admin = payload;
    next();
  } catch (_error) {
    return res.status(401).json({
      status: 'unauthorized',
      message: 'Invalid or expired admin token.',
    });
  }
}

module.exports = { requireAdmin };