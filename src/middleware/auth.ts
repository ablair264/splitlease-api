import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        name?: string;
      };
    }
  }
}

export const requireAuth = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "No authorization header" });
    }

    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      console.error("AUTH_SECRET not configured");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Verify JWT token (NextAuth compatible)
    const decoded = jwt.verify(token, secret) as {
      sub?: string;
      id?: string;
      email?: string;
      name?: string;
    };

    req.user = {
      id: decoded.sub || decoded.id || "",
      email: decoded.email,
      name: decoded.name,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: "Token expired" });
    }
    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({ error: "Invalid token" });
    }
    return res.status(401).json({ error: "Unauthorized" });
  }
};

// Optional auth - populates user if token present, but doesn't require it
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return next();
    }

    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return next();
    }

    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      return next();
    }

    const decoded = jwt.verify(token, secret) as {
      sub?: string;
      id?: string;
      email?: string;
      name?: string;
    };

    req.user = {
      id: decoded.sub || decoded.id || "",
      email: decoded.email,
      name: decoded.name,
    };

    next();
  } catch {
    // Token invalid but that's okay for optional auth
    next();
  }
};
