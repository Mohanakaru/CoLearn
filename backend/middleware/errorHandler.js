'use strict';

/* ── Global Express error handler ────────────────────────── */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  // Log the full error server-side (never sent to client)
  if (status >= 500) {
    console.error(`[ERROR] ${req.method} ${req.url} → ${status}:`, err.message);
  } else {
    console.warn(`[WARN] ${req.method} ${req.url} → ${status}:`, err.message);
  }

  // In production: never reveal internal details to the client
  const isProduction = process.env.NODE_ENV === 'production';
  const clientMessage = isProduction
    ? getGenericMessage(status)
    : (err.message || getGenericMessage(status));

  res.status(status).json({
    success: false,
    error:   clientMessage,
  });
}

/** Returns a friendly generic message for common HTTP status codes. */
function getGenericMessage(status) {
  switch (status) {
    case 400: return 'Bad request. Please check your input.';
    case 401: return 'Authentication required. Please log in.';
    case 403: return 'You do not have permission to perform this action.';
    case 404: return 'The requested resource was not found.';
    case 409: return 'A conflict occurred. The resource may already exist.';
    case 429: return 'Too many requests. Please wait and try again.';
    default:  return 'Internal server error. Please try again later.';
  }
}

module.exports = errorHandler;
