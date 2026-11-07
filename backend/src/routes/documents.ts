import { Router } from "express";
import {
  deleteDocument,
  downloadOriginal,
  getDocument,
  listDocuments,
  patchFinding,
  uploadDocument,
} from "../controllers/documents";
import { asyncHandler } from "../middleware/errors";
import { pilotAuth } from "../middleware/pilot-auth";
import { checkDeclaredBodySize, uploadSingleFile } from "../middleware/upload";

export function documentsRouter(): Router {
  const router = Router();
  router.use(pilotAuth);
  router.get("/", asyncHandler(listDocuments));
  router.post("/", checkDeclaredBodySize, uploadSingleFile(), asyncHandler(uploadDocument));
  router.get("/:id", asyncHandler(getDocument));
  router.delete("/:id", asyncHandler(deleteDocument));
  router.get("/:id/file", asyncHandler(downloadOriginal));
  router.patch("/:id/findings/:findingId", asyncHandler(patchFinding));
  return router;
}
