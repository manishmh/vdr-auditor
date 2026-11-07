"use client";

import { use } from "react";
import { ReviewClient } from "./ReviewClient";

/** Unwraps route params on the client so the page can stream under cacheComponents. */
export function ReviewRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ReviewClient docId={id} />;
}

export function ReviewRouteFallback() {
  return (
    <div className="space-y-4" aria-label="Loading document">
      <div className="h-8 w-64 animate-pulse rounded bg-stone-200" />
      <div className="h-40 animate-pulse rounded-lg bg-stone-100" />
      <div className="h-64 animate-pulse rounded-lg bg-stone-100" />
    </div>
  );
}
