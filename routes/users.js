// routes/users.js
import express from "express";
import { register, login } from "../controllers/userController.js";
const router = express.Router();

// REGISTER ROUTE
router.post("/register", register);

// LOGIN ROUTE
router.post("/login", login);

export default router;
