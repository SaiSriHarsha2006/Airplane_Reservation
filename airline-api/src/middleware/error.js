import { ZodError } from 'zod';
import { AppError } from '../errors.js';

export function notFound(_req, _res, next) {
  next(new AppError(404, 'Route not found'));
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate record' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });

  // Never leak SQL / stack details to the client
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
