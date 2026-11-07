#!/usr/bin/env node
/**
 * Local development runner: starts the backend (Express :3001) and the
 * frontend (Next.js :3000) together with prefixed logs.
 *
 * Why this exists: the frontend proxies `/api/*` to the backend, so running
 * Next.js alone leaves every API call failing with ECONNREFUSED 127.0.0.1:3001.
 * This runner keeps both processes up, shuts both down on Ctrl+C, and makes a
 * backend crash loud instead of leaving the proxy without a server.
 *
 * Zero dependencies (node:child_process only). For independent startup use
 * `npm run dev:web` (frontend only) or `npm run dev:api` (backend only).
 *
 * Escape hatches: `WEB_PORT` moves the frontend off :3000 (the backend must
 * stay on `PORT`, default 3001, because the dev rewrite targets it).
 */
import { spawn } from "node:child_process";

const webArgs = ["run", "dev:web"];
if (process.env.WEB_PORT) webArgs.push("--", "-p", process.env.WEB_PORT);

const CHILDREN = [
  { name: "api", command: "npm", args: ["run", "dev:api"], required: true },
  { name: "web", command: "npm", args: webArgs, required: false },
];

const procs = [];
let shuttingDown = false;

function log(name, chunk) {
  for (const line of String(chunk).split("\n")) {
    if (line.length > 0) process.stdout.write(`[${name}] ${line}\n`);
  }
}

/**
 * Kill a child and everything it spawned (npm/sh wrappers reparent
 * grandchildren, so killing only the direct child orphans the server).
 * Children are spawned detached (own process group); negative-PID kill hits
 * the whole group, with a plain kill fallback for already-dead processes.
 */
function killTree(child, signal) {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone; nothing to stop.
    }
  }
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of procs) killTree(child, "SIGTERM");
  // Escalate to SIGKILL for stragglers, then force the outcome.
  setTimeout(() => {
    for (const child of procs) {
      if (child.exitCode === null) killTree(child, "SIGKILL");
    }
    process.exit(exitCode);
  }, 2000).unref();
}

for (const spec of CHILDREN) {
  const child = spawn(spec.command, spec.args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(child);
  child.stdout.on("data", (chunk) => log(spec.name, chunk));
  child.stderr.on("data", (chunk) => log(spec.name, chunk));
  child.on("error", (err) => {
    console.error(`[dev] failed to start ${spec.name}: ${err.message}`);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (spec.required) {
      console.error(
        `[dev] BACKEND EXITED (code=${code ?? "?"} signal=${signal ?? "none"}). ` +
          `The frontend proxy has no server: fix the backend error above and restart. Shutting down.`,
      );
      shutdown(code ?? 1);
    } else {
      console.error(`[dev] frontend exited (code=${code ?? "?"} signal=${signal ?? "none"}). Shutting down.`);
      shutdown(code ?? 1);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
