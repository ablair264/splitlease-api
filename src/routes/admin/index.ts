import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import dashboardRouter from "./dashboard.js";
import dealsRouter from "./deals.js";
import ratebooksRouter from "./ratebooks.js";
import ratesRouter from "./rates.js";

const router = Router();

// All admin routes require authentication
router.use(requireAuth);

// Sub-routes
router.use("/dashboard", dashboardRouter);
router.use("/deals", dealsRouter);
router.use("/ratebooks", ratebooksRouter);
router.use("/rates", ratesRouter);

export default router;
