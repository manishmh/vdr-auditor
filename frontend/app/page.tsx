"use client";

import { useEffect, useState } from "react";
import {
  fetchStatusReport,
  type Probe,
  type ProbeState,
  type StatusReport,
} from "@/lib/health";

const API_URL = process.env["NEXT_PUBLIC_API_URL"];
const CHECKING: Probe = { state: "checking", detail: "Checking…" };

function Badge({ state }: { state: ProbeState }) {
  const styles: Record<ProbeState, string> = {
    checking: "bg-amber-100 text-amber-800",
    ok: "bg-emerald-100 text-emerald-800",
    error: "bg-red-100 text-red-800",
  };
  const labels: Record<ProbeState, string> = {
    checking: "Checking",
    ok: "Healthy",
    error: "Error",
  };
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[state]}`}
      role="status"
    >
      {labels[state]}
    </span>
  );
}

function StatusRow({
  name,
  description,
  probe,
}: {
  name: string;
  description: string;
  probe: Probe;
}) {
  return (
    <li className="flex items-start justify-between gap-4 border-b border-zinc-200 py-4 last:border-b-0">
      <div>
        <p className="font-medium">{name}</p>
        <p className="mt-0.5 text-sm text-zinc-600">{description}</p>
        {probe.state !== "checking" && (
          <p className="mt-1 text-sm text-zinc-600">{probe.detail}</p>
        )}
      </div>
      <Badge state={probe.state} />
    </li>
  );
}

export default function StatusPage() {
  // Null until the first client-side probe resolves. Server and client both
  // render the checking state, so hydration always matches; all timestamps
  // come from client-side fetches only.
  const [report, setReport] = useState<StatusReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStatusReport(API_URL).then((next) => {
      if (!cancelled) {
        setReport(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onRetry = () => {
    setReport(null);
    fetchStatusReport(API_URL).then(setReport);
  };

  const backend = report?.backend ?? CHECKING;
  const database = report?.database ?? CHECKING;
  const backendUrl = API_URL ?? "(unconfigured)";
  const failed =
    backend.state === "error" || database.state === "error";
  const checking =
    backend.state === "checking" || database.state === "checking";

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">VDR Auditor</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Phase 1 foundation status. No auditor features yet.
      </p>

      <section aria-label="Service status" className="mt-8">
        <ul>
          <StatusRow
            name="Frontend"
            description="This Next.js application."
            probe={{ state: "ok", detail: "Page rendered successfully." }}
          />
          <StatusRow
            name="Backend API"
            description={`GET ${backendUrl}/api/health`}
            probe={backend}
          />
          <StatusRow
            name="MongoDB"
            description={`GET ${backendUrl}/api/health/ready`}
            probe={database}
          />
        </ul>
      </section>

      <div className="mt-6 flex items-center gap-4">
        {failed && !checking && (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Retry
          </button>
        )}
        {report !== null && (
          <p className="text-sm text-zinc-600">
            Last checked: {report.lastChecked}
          </p>
        )}
      </div>
    </main>
  );
}
