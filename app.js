// Vyas-Backend\app.js
import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
import buildingRoutes from "./routes/buildings.js";
import userRoutes from "./routes/users.js"

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(cors({ credentials: true }));

app.get("/", (req, res) => {
  res.send("✅ Server is running!");
});

// Routes
app.use("/building", buildingRoutes);
app.use("/user", userRoutes);

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
