/**
 * pdfjs-dist ships types for its main entry but not for the worker module,
 * which we import (for bundler visibility) without using its value.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  const WorkerMessageHandler: unknown;
  export { WorkerMessageHandler };
}
