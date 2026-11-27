"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OnProgressParameters,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  TextLayer as TextLayerInstance,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { findExcerptRanges, joinLayerItemsWithBreaks } from "@/lib/pdfText";
import { Button, ErrorBlock, LoadingLine } from "./ui";

export interface HighlightReport {
  /** Real PDF page the report refers to. */
  page: number;
  /** Exact excerpt matches located in the page's PDF text. */
  matches: number;
}

interface PdfViewerProps {
  /** Inline PDF download URL (range-capable). */
  url: string;
  /** Controlled 1-based page; clamped into the document. */
  page: number;
  /** Evidence excerpt to locate on the page, or null for none. */
  excerpt: string | null;
  /**
   * Reruns the locate step when the active finding changes even if the
   * excerpt text is identical (typically the finding id).
   */
  highlightKey: string;
  onPagesKnown?: (numPages: number) => void;
  onPageChange?: (page: number) => void;
  /** Fires after each render: match counts, or null when locating nothing. */
  onHighlight?: (report: HighlightReport | null) => void;
}

type ViewerStatus = "loading" | "ready" | "password" | "unavailable" | "error";

const WORKER_SRC = "/pdf.worker.min.mjs";
const ZOOM_STEP = 1.25;
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const MAX_OUTPUT_SCALE = 2;
/**
 * Give up only when no bytes arrive for this long (dead worker, hung
 * connection). Slow-but-flowing loads extend the deadline via progress
 * events instead of dying to a wall clock.
 */
const LOAD_STALL_MS = 30000;

let workerConfigured = false;

function describeLoadFailure(err: unknown): ViewerStatus {
  // Safe error class only; pdf.js messages can echo URL details.
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (name === "PasswordException") {
      return "password";
    }
    if (
      name === "ResponseException" &&
      ((err as { status?: unknown }).status === 404 ||
        (err as { status?: unknown }).status === 409)
    ) {
      return "unavailable";
    }
  }
  return "error";
}

function wrapRangeInMark(div: HTMLElement, start: number, end: number): HTMLElement | null {
  // All descendant text nodes in document order, including earlier marks'
  // contents: offsets stay aligned with the div's original string no matter
  // how many ranges one div holds. Never double-wrap an existing mark.
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current !== null) {
    nodes.push(current as Text);
    current = walker.nextNode();
  }
  let offset = 0;
  for (const textNode of nodes) {
    const text = textNode.textContent ?? "";
    const nodeStart = offset;
    const nodeEnd = offset + text.length;
    offset = nodeEnd;
    const overlapStart = Math.max(start, nodeStart);
    const overlapEnd = Math.min(end, nodeEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    if (textNode.parentElement?.closest("mark.pdf-mark") !== null) {
      continue;
    }
    const before = textNode.splitText(overlapStart - nodeStart);
    before.splitText(overlapEnd - overlapStart);
    const mark = document.createElement("mark");
    mark.className = "pdf-mark";
    before.replaceWith(mark);
    mark.appendChild(before);
    return mark;
  }
  return null;
}

export default function PdfViewer({
  url,
  page,
  excerpt,
  highlightKey,
  onPagesKnown,
  onPageChange,
  onHighlight,
}: PdfViewerProps) {
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [scale, setScale] = useState(1);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pageInput, setPageInput] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const pageWidthRef = useRef<number | null>(null);
  const renderedPageRef = useRef<number | null>(null);
  const fitDoneRef = useRef(false);

  // A new `url` must remount this component (parent passes key={url});
  // retries below reset state from the click handler instead of the effect.
  const retryLoad = (): void => {
    setStatus("loading");
    setLoadProgress(null);
    setNumPages(null);
    setMatchCount(null);
    setReloadKey((key) => key + 1);
  };

  // Load (or reload) the document. Range-only fetching (no full-file
  // stream, no speculative prefetch) fits a single-page viewer: the first
  // paint needs the header plus the xref tail, not the whole file.
  useEffect(() => {
    let cancelled = false;
    docRef.current = null;
    renderedPageRef.current = null;
    fitDoneRef.current = false;
    const task = { current: null as { destroy: () => Promise<unknown> } | null };
    const timerHolder = { current: null as ReturnType<typeof setTimeout> | null };
    const clearTimer = (): void => {
      if (timerHolder.current !== null) {
        clearTimeout(timerHolder.current);
        timerHolder.current = null;
      }
    };
    const failStalled = (loadingTask: { destroy: () => Promise<unknown> }): void => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      task.current = null;
      // Destroying alone is not enough: a task stuck before the worker
      // handshake may never settle its promise, so fail explicitly.
      loadingTask.destroy().catch(() => undefined);
      setStatus("error");
    };
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        if (!workerConfigured) {
          pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC;
          workerConfigured = true;
        }
        const loadingTask = pdfjs.getDocument({
          url,
          useSystemFonts: true,
          disableStream: true,
          disableAutoFetch: true,
        });
        task.current = loadingTask;
        // Stall (not wall-clock) timeout: every progress event extends the
        // deadline, so slow pipes keep loading while dead ones surface the
        // error state with retry instead of spinning forever.
        timerHolder.current = setTimeout(() => failStalled(loadingTask), LOAD_STALL_MS);
        loadingTask.onProgress = (data: OnProgressParameters): void => {
          if (cancelled) {
            return;
          }
          if (data.total > 0) {
            setLoadProgress(Math.min(1, data.loaded / data.total));
          }
          clearTimer();
          timerHolder.current = setTimeout(() => failStalled(loadingTask), LOAD_STALL_MS);
        };
        let doc: PDFDocumentProxy;
        try {
          doc = await loadingTask.promise;
        } finally {
          clearTimer();
        }
        if (cancelled) {
          await loadingTask.destroy().catch(() => undefined);
          return;
        }
        docRef.current = doc;
        setNumPages(doc.numPages);
        onPagesKnown?.(doc.numPages);
        setStatus("ready");
      } catch (err: unknown) {
        if (!cancelled) {
          setStatus(describeLoadFailure(err));
        }
      }
    })();
    return () => {
      cancelled = true;
      clearTimer();
      task.current?.destroy().catch(() => undefined);
      docRef.current = null;
    };
    // Parent callbacks only; page changes render through the render effect
    // below, not through a document reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reloadKey]);

  const fitWidth = useCallback(() => {
    const width = pageWidthRef.current;
    const container = scrollRef.current;
    if (width === null || width <= 0 || container === null) {
      return;
    }
    const next = (container.clientWidth - 32) / width;
    if (Number.isFinite(next)) {
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
    }
  }, []);

  // Render the controlled page: canvas paint plus a selectable text layer
  // that doubles as the highlight surface. Stale renders (fast finding or
  // zoom switches) are cancelled and never apply.
  useEffect(() => {
    if (status !== "ready") {
      return;
    }
    const doc = docRef.current;
    const canvas = canvasRef.current;
    const layer = textLayerRef.current;
    if (doc === null || canvas === null || layer === null) {
      return;
    }
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayerInstance | null = null;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const target = numPages === null ? page : Math.min(Math.max(1, page), numPages);
        const pdfPage: PDFPageProxy = await doc.getPage(target);
        if (cancelled) {
          pdfPage.cleanup();
          return;
        }
        pageWidthRef.current = pdfPage.getViewport({ scale: 1 }).width;
        const viewport = pdfPage.getViewport({ scale });
        const outputScale =
          typeof window === "undefined"
            ? 1
            : Math.min(window.devicePixelRatio || 1, MAX_OUTPUT_SCALE);
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext("2d");
        if (context === null) {
          throw new Error("canvas 2d unavailable");
        }
        renderTask = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) {
          return;
        }
        const textContent = await pdfPage.getTextContent();
        if (cancelled) {
          return;
        }
        layer.replaceChildren();
        textLayer = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: layer,
          viewport,
        });
        await textLayer.render();
        if (cancelled) {
          return;
        }
        const pageChanged = renderedPageRef.current !== target;
        renderedPageRef.current = target;
        pdfPage.cleanup();
        // Locate evidence in the page's own PDF text (grounded; never
        // guessed). Every repeated occurrence highlights; no match means
        // an honest fallback in the rail, not a silent miss.
        let firstMark: HTMLElement | null = null;
        if (excerpt === null) {
          setMatchCount(null);
          onHighlight?.(null);
        } else {
          const divs = textLayer.textDivs;
          const items = divs.map((div) => div.textContent ?? "");
          // TextLayer emits one div per content item with text, in order —
          // the same items extraction joins, so reuse their end-of-line
          // flags to separate lines exactly like the stored text. If that
          // alignment ever drifts, fall back to unseparated div text rather
          // than mis-highlighting.
          const strItems = (
            textContent.items as Array<{ str?: unknown; hasEOL?: unknown }>
          ).filter((item) => typeof item.str === "string");
          const breaks =
            strItems.length === divs.length
              ? strItems.map((item) => item.hasEOL === true)
              : divs.map(() => false);
          const joined = joinLayerItemsWithBreaks(items, breaks);
          let cursor = 0;
          const itemStarts = items.map((item) => {
            const start = cursor;
            cursor += item.length;
            return start;
          });
          const ranges = findExcerptRanges(joined.text, excerpt);
          for (const range of ranges) {
            for (let offset = range.start; offset < range.end; ) {
              const itemIndex = joined.itemAt[offset] as number;
              let itemEnd = offset + 1;
              while (itemEnd < range.end && joined.itemAt[itemEnd] === itemIndex) {
                itemEnd += 1;
              }
              const div = divs[itemIndex] as HTMLElement | undefined;
              const itemStart = itemStarts[itemIndex] as number;
              if (div !== undefined && itemStart !== undefined) {
                const mark = wrapRangeInMark(div, offset - itemStart, itemEnd - itemStart);
                if (firstMark === null && mark !== null) {
                  firstMark = mark;
                }
              }
              offset = itemEnd;
            }
          }
          setMatchCount(ranges.length);
          onHighlight?.({ page: target, matches: ranges.length });
        }
        if (firstMark !== null) {
          firstMark.scrollIntoView({ block: "center" });
        } else if (pageChanged) {
          scrollRef.current?.scrollTo({ top: 0 });
        }
        if (!fitDoneRef.current) {
          // First paint knows the real page width: fit it, then re-render.
          fitDoneRef.current = true;
          fitWidth();
        }
      } catch (err: unknown) {
        if (cancelled) {
          return;
        }
        if (typeof err === "object" && err !== null) {
          const name = (err as { name?: unknown }).name;
          if (name === "RenderingCancelledException") {
            return;
          }
        }
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        // Already settled; nothing to cancel.
      }
      try {
        textLayer?.cancel();
      } catch {
        // Already settled; nothing to cancel.
      }
    };
    // highlightKey rescopes identical excerpts to a new finding; scale and
    // excerpt re-render the same page in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, numPages, page, scale, excerpt, highlightKey, url, reloadKey, fitWidth]);

  const goToPage = (next: number): void => {
    if (numPages === null) {
      return;
    }
    const clamped = Math.min(Math.max(1, next), numPages);
    setPageInput(null);
    onPageChange?.(clamped);
  };

  const commitPageInput = (): void => {
    if (pageInput === null) {
      return;
    }
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isInteger(parsed)) {
      goToPage(parsed);
    } else {
      setPageInput(null);
    }
  };

  const zoomBy = (factor: number): void => {
    setScale((current) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor)));
  };

  if (status === "loading") {
    return (
      <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-slate-200 bg-white px-6">
        <LoadingLine>
          {loadProgress === null
            ? "Loading PDF…"
            : `Loading PDF… ${Math.round(loadProgress * 100)}%`}
        </LoadingLine>
        {loadProgress !== null && (
          <div
            className="h-1.5 w-48 overflow-hidden rounded-full bg-slate-200"
            role="progressbar"
            aria-valuenow={Math.round(loadProgress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="PDF loading progress"
          >
            <div
              className="h-full rounded-full bg-blue-800 transition-[width]"
              style={{ width: `${Math.round(loadProgress * 100)}%` }}
            />
          </div>
        )}
      </div>
    );
  }

  if (status === "password") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-6 py-10">
        <ErrorBlock message="This PDF is password-protected and cannot be displayed here. Download it to review outside the app." />
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-6 py-10">
        <ErrorBlock
          message="The PDF file is no longer available. It may have been deleted."
          onRetry={retryLoad}
        />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="rounded-lg border border-slate-200 bg-white px-6 py-10">
        <ErrorBlock
          message="Couldn't display this PDF. The file may be damaged, or the connection dropped."
          onRetry={retryLoad}
        />
      </div>
    );
  }

  const shownPage = numPages === null ? page : Math.min(Math.max(1, page), numPages);

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-slate-200 bg-white">
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 px-3 py-2"
        role="toolbar"
        aria-label="PDF viewer controls"
      >
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            onClick={() => goToPage(shownPage - 1)}
            disabled={shownPage <= 1}
            aria-label="Previous page"
          >
            ‹
          </Button>
          <span className="flex items-center gap-1 text-sm whitespace-nowrap text-slate-700">
            <input
              type="text"
              inputMode="numeric"
              aria-label="Page number"
              value={pageInput ?? String(shownPage)}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={commitPageInput}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commitPageInput();
                }
              }}
              className="w-12 rounded-md border border-slate-300 px-1 py-0.5 text-center text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
            />
            <span className="tabular-nums">of {numPages ?? "…"}</span>
          </span>
          <Button
            size="sm"
            onClick={() => goToPage(shownPage + 1)}
            disabled={numPages !== null && shownPage >= numPages}
            aria-label="Next page"
          >
            ›
          </Button>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <Button size="sm" onClick={() => zoomBy(1 / ZOOM_STEP)} aria-label="Zoom out">
            −
          </Button>
          <span className="w-12 text-center text-sm tabular-nums text-slate-700">
            {Math.round(scale * 100)}%
          </span>
          <Button size="sm" onClick={() => zoomBy(ZOOM_STEP)} aria-label="Zoom in">
            +
          </Button>
          <Button size="sm" onClick={fitWidth}>
            Fit width
          </Button>
        </div>
        {excerpt !== null && matchCount !== null && (
          <p className="text-[13px] text-slate-600" role="status">
            {matchCount === 0
              ? "Evidence not located on this page"
              : `${matchCount} ${matchCount === 1 ? "match" : "matches"} on this page`}
          </p>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-slate-100 p-4">
        <div className="pdf-page mx-auto w-fit shadow-md">
          <canvas ref={canvasRef} className="block rounded-sm bg-white" />
          <div ref={textLayerRef} className="pdf-text-layer" />
        </div>
      </div>
    </div>
  );
}
