'use strict';

class AppError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'غير موجود.') {
    super(404, message, 'not_found');
  }
}

class ConflictError extends AppError {
  constructor(message = 'تعارض في البيانات.', code = 'conflict') {
    super(409, message, code);
  }
}

module.exports = { AppError, NotFoundError, ConflictError };
