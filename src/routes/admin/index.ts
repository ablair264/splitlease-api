import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import dashboardRouter from "./dashboard.js";
import dealsRouter from "./deals.js";
import ratebooksRouter from "./ratebooks.js";
import ratesRouter from "./rates.js";

const router = Router();

// Ratebooks routes - no auth for now (internal tool)
// TODO: Add proper auth when ready
router.use("/ratebooks", ratebooksRouter);

// All other admin routes require authentication
router.use(requireAuth);

// Sub-routes (protected)
router.use("/dashboard", dashboardRouter);
router.use("/deals", dealsRouter);
router.use("/rates", ratesRouter);

export default router;
