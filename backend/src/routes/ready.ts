import { Router } from "express";
import { ready } from "../controllers/ready";
import { asyncHandler } from "../middleware/errors";
import { pilotAuth } from "../middleware/pilot-auth";

export function readyRouter(): Router {
  const router = Router();
  router.use(pilotAuth);
  router.get("/", asyncHandler(ready));
  return router;
}
