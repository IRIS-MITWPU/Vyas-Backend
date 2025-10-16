import express from 'express';
import dotenv from 'dotenv';
import pool from './database/db.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());


app.get('/', (req, res) => {
  res.send('✅ Server is running!');
});

// DB check route
app.get('/db-check', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.send(`✅ DB connected successfully! Time: ${result.rows[0].now}`);
  } catch (err) {
    console.error('DB check error:', err);
    res.status(500).send('Failed to connect to database.');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
