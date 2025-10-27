// controllers/userController.js
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { registerUser, findUserByEmail } from "../models/userModel.js";

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "Strict",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });
};

// Helper to check valid MIT-WPU email
const checkValidMail = (email) => email.endsWith("@mitwpu.edu.in");

// REGISTER CONTROLLER
export async function register(req, res) {
  const { full_name, email, password } = req.body;

  try {

    if (!checkValidMail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email domain. Use your @mitwpu.edu.in email.",
      });
    }

    const user = await registerUser(full_name, email, password);
    const token = generateToken(user.id);

    res.cookie("token", token, cookieOptions);

    res.status(201).json({
      message: "User registered successfully",
      user,
      token,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// LOGIN CONTROLLER
export async function login(req, res) {
  const { email, password } = req.body;

  try {

    if (!checkValidMail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email domain. Use your @mitwpu.edu.in email.",
      });
    }

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

    const token = generateToken(user.user_id);
    res.cookie("token", token, cookieOptions);

    res.json({
      message: "Login successful",
      user: {
        id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        is_admin: user.is_admin,
      },
      token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
