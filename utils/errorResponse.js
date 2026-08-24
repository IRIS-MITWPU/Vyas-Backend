// utils/errorResponse.js
// Shared helper so raw Postgres/error text (constraint names, trigger wording,
// column names) never reaches a client in production. Full error is always
// logged server-side; `details` is only attached outside production.

export function buildErrorBody(genericMessage, err) {
  const body = { error: genericMessage };
  if (process.env.NODE_ENV !== "production" && err?.message) {
    body.details = err.message;
  }
  return body;
}

export function sendError(res, status, genericMessage, err) {
  if (err) console.error(genericMessage, err);
  return res.status(status).json(buildErrorBody(genericMessage, err));
}
