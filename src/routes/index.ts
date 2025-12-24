import { Router } from "express";
import vehiclesRouter from "./vehicles.js";
import ratesRouter from "./rates.js";
import leadsRouter from "./leads.js";
import adminRouter from "./admin/index.js";
import lexAutoLeaseRouter from "./lex-autolease.js";
import ogilvieRouter from "./ogilvie.js";
import fleetMarqueRouter from "./fleet-marque.js";

const router = Router();

// Public routes
router.use("/vehicles", vehiclesRouter);
router.use("/rates", ratesRouter);
router.use("/leads", leadsRouter);

// Admin routes (protected)
router.use("/admin", adminRouter);

// Provider integration routes (protected)
router.use("/lex-autolease", lexAutoLeaseRouter);
router.use("/ogilvie", ogilvieRouter);
router.use("/fleet-marque", fleetMarqueRouter);

export default router;
