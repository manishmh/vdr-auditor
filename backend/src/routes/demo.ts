import { Router } from "express";
import { seedDemo } from "../controllers/demo";
import { asyncHandler } from "../middleware/errors";
import { pilotAuth } from "../middleware/pilot-auth";

export function demoRouter(): Router {
  const router = Router();
  router.use(pilotAuth);
  router.post("/seed", asyncHandler(seedDemo));
  return router;
}
