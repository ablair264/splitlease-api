import { Router } from "express";
import vehiclesRouter from "./vehicles.js";
import ratesRouter from "./rates.js";
import leadsRouter from "./leads.js";
import adminRouter from "./admin/index.js";

const router = Router();

// Public routes
router.use("/vehicles", vehiclesRouter);
router.use("/rates", ratesRouter);
router.use("/leads", leadsRouter);

// Admin routes (protected)
router.use("/admin", adminRouter);

export default router;
