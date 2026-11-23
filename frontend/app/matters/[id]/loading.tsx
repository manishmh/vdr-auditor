/**
 * Instant navigation feedback for /matters/[id]. Next.js shows this while
 * the route payload loads, so a slow (cold) navigation never looks stuck on
 * the previous page. Server-rendered: no hooks, no data fetching.
 */
export default function MatterLoading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8" aria-busy="true" data-skeleton="matter">
      <span className="sr-only" role="status">
        Loading matter…
      </span>
      <div className="flex items-center gap-2" aria-hidden="true">
        <div className="h-4 w-16 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="h-4 w-24 rounded-md bg-slate-200 motion-safe:animate-pulse" />
      </div>
      <div className="mt-4 h-8 w-72 max-w-full rounded-md bg-slate-200 motion-safe:animate-pulse" aria-hidden="true" />
      <div className="mt-2 h-4 w-96 max-w-full rounded-md bg-slate-100 motion-safe:animate-pulse" aria-hidden="true" />
      <div className="mt-10" aria-hidden="true">
        <div className="h-6 w-32 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-white p-4">
          <div className="h-10 rounded-md bg-slate-100 motion-safe:animate-pulse" />
          <div className="h-10 rounded-md bg-slate-100 motion-safe:animate-pulse" />
          <div className="h-10 rounded-md bg-slate-100 motion-safe:animate-pulse" />
        </div>
      </div>
    </main>
  );
}
