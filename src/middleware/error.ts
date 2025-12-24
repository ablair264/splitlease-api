import { Request, Response, NextFunction } from "express";

export class ApiError extends Error {
  statusCode: number;
  details?: unknown;

  constructor(message: string, statusCode: number = 500, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.name = "ApiError";
  }
}

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  console.error("Error:", err);

  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      error: err.message,
      ...(err.details && { details: err.details }),
    });
  }

  // Handle Zod validation errors
  if (err.name === "ZodError") {
    return res.status(400).json({
      error: "Validation error",
      details: err,
    });
  }

  // Default error
  return res.status(500).json({
    error: err.message || "Internal server error",
  });
};

// Helper to wrap async route handlers
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
