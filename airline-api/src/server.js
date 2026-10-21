import app from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

const server = app.listen(config.port, () =>
  console.log(`API running on http://localhost:${config.port}`));

// Graceful shutdown: finish in-flight requests, then close DB connections
const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
