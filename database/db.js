import pkg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pkg;   

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
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
