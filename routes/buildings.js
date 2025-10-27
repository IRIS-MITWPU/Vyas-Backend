import express from 'express';
import db from '../database/db.js'

const router = express.Router();


// GET /building/:name → show building by name
router.get('/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const result = await db.query(
      'SELECT * FROM buildings WHERE LOWER(name) = LOWER($1);',
      [name]
    );
    

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Building not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching building:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
