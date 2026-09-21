import pkg from 'pg';
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const { Pool } = pkg;

const defaultCa = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'rds-global-bundle.pem');

// DB_SSL=true -> verify the server against a CA bundle (RDS global bundle by default; RDS
// Postgres 15+ has rds.force_ssl=1). Never falls back to rejectUnauthorized:false.
export function buildSslConfig(env) {
  if (String(env.DB_SSL).toLowerCase() !== 'true') return undefined;
  const caPath = env.DB_SSL_CA || defaultCa;
  let ca;
  try {
    ca = readFileSync(caPath);
  } catch (err) {
    throw new Error(`DB_SSL=true but the CA bundle could not be read (${caPath}): ${err.message}`);
  }
  return { ca, rejectUnauthorized: true };
}

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  max: Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: buildSslConfig(process.env),
});

// Without this, an idle client emitting a backend error (DB restart, network
// blip, managed-Postgres failover) is an uncaught exception that kills the
// whole process instead of just that one connection.
pool.on('error', (err) => {
  console.error('❌ Unexpected PG pool error:', err);
});

// Test connection on startup
pool.connect()
  .then(client => {
    console.log('✅ Connected to PostgreSQL database');
    client.release();
  })
  .catch(err => {
    console.error('❌ Error connecting to DB:', err.stack);
  });

export default pool;
