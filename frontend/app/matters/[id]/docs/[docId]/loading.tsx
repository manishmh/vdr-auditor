/**
 * Instant navigation feedback for /matters/[id]/docs/[docId]. Shown while
 * the route payload loads, so a slow (cold) navigation never looks stuck on
 * the previous page. Server-rendered: no hooks, no data fetching.
 */
export default function DocumentLoading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8" aria-busy="true" data-skeleton="document">
      <span className="sr-only" role="status">
        Loading document…
      </span>
      <div className="flex items-center gap-2" aria-hidden="true">
        <div className="h-4 w-16 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="h-4 w-24 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="h-4 w-40 rounded-md bg-slate-200 motion-safe:animate-pulse" />
      </div>
      <div className="mt-4 h-8 w-80 max-w-full rounded-md bg-slate-200 motion-safe:animate-pulse" aria-hidden="true" />
      <div className="mt-2 h-4 w-64 max-w-full rounded-md bg-slate-100 motion-safe:animate-pulse" aria-hidden="true" />
      <div className="mt-4 flex gap-2" aria-hidden="true">
        <div className="h-8 w-24 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="h-8 w-20 rounded-md bg-slate-100 motion-safe:animate-pulse" />
      </div>
      <div className="mt-6 rounded-lg border border-slate-200 bg-white px-5 py-4" aria-hidden="true">
        <div className="h-4 w-56 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="mt-3 h-2 w-full rounded-full bg-slate-100 motion-safe:animate-pulse" />
      </div>
      <div className="mt-10" aria-hidden="true">
        <div className="h-6 w-24 rounded-md bg-slate-200 motion-safe:animate-pulse" />
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
          <div className="h-24 rounded-md bg-slate-100 motion-safe:animate-pulse" />
        </div>
      </div>
    </main>
  );
}
