// models/userModel.js
import pool from '../database/db.js';
import bcrypt from 'bcryptjs';

export async function registerUser(full_name, email, password) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const checkUser = await client.query(
      "SELECT * FROM profiles WHERE email = $1",
      [email]
    );
    if (checkUser.rows.length > 0) {
      throw new Error("User already exists");
    }

    const profileResult = await client.query(
      `INSERT INTO profiles (full_name, email)
       VALUES ($1, $2)
       RETURNING id, full_name, email, is_admin`,
      [full_name, email]
    );

    const userId = profileResult.rows[0].id;
    const hashedPassword = await bcrypt.hash(password, 10);

    await client.query(
      `INSERT INTO user_auth (user_id, password_hash)
       VALUES ($1, $2)`,
      [userId, hashedPassword]
    );

    await client.query("COMMIT");
    return profileResult.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email) {
  const query = `
    SELECT 
      p.id AS user_id,
      p.full_name,
      p.email,
      p.is_admin,
      a.password_hash
    FROM profiles p
    JOIN user_auth a ON p.id = a.user_id
    WHERE p.email = $1
  `;
  const result = await pool.query(query, [email]);
  return result.rows[0];
}
