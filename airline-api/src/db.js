import mysql from 'mysql2/promise';
import { config } from './config.js';

// Connection pool: reuses connections instead of opening one per request.
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z',
  multipleStatements: false, // blocks stacked-query SQL injection
});

// Prepared statements (execute) => parameters are never concatenated into SQL.
export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

// Runs fn(conn) in a transaction; commits on success, rolls back on any error.
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Helper for use inside a transaction
export async function q(conn, sql, params = []) {
  const [rows] = await conn.execute(sql, params);
  return rows;
}
