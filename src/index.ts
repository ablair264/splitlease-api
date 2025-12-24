import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { errorHandler } from "./middleware/error.js";
import { requestLogger } from "./middleware/logger.js";
import routes from "./routes/index.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());
app.use(compression());

// CORS configuration
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use(requestLogger);

// Health check (before routes for quick response)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API routes
app.use("/api", routes);

// Error handling
app.use(errorHandler);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`🚀 Splitlease API running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});

export default app;
