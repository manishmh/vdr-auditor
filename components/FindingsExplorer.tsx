"use client";

import { useMemo, useState } from "react";
import { SearchX } from "lucide-react";
import type { ReviewStatus, Severity, StoredFinding } from "@/lib/findings/schema";
import { RISK_CATEGORIES } from "@/lib/risks";
import { cn } from "@/lib/utils";
import { ApiError, patchFinding } from "./api";
import { CategoryLabel, Folio, REVIEW_STATUS_OPTIONS, ReviewStatusBadge, SeverityBadge } from "./badges";
import { Button } from "./ui/button";
import { FieldLabel, Select, TextArea, TextInput } from "./ui/fields";

interface Props {
  documentId: string;
  findings: StoredFinding[];
  onFindingUpdated: (finding: StoredFinding) => void;
  onUnauthorized: () => void;
}

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export function FindingsExplorer({ documentId, findings, onFindingUpdated, onUnauthorized }: Props) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter((f) => {
      if (category !== "all" && f.category !== category) return false;
      if (severity !== "all" && f.severity !== severity) return false;
      if (status !== "all" && f.status !== status) return false;
      if (q && !(f.title + " " + f.explanation + " " + f.evidence).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [findings, query, category, severity, status]);

  const selected = filtered.find((f) => f.id === selectedId) ?? filtered[0] ?? null;
  const filtersActive = query !== "" || category !== "all" || severity !== "all" || status !== "all";

  function clearFilters() {
    setQuery("");
    setCategory("all");
    setSeverity("all");
    setStatus("all");
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-45 flex-1">
          <FieldLabel htmlFor="finding-search">Search</FieldLabel>
          <TextInput
            id="finding-search"
            placeholder="Search findings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full"
          />
        </div>
        <div>
          <FieldLabel htmlFor="filter-category">Category</FieldLabel>
          <Select id="filter-category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">All categories</option>
            {RISK_CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="filter-severity">Severity</FieldLabel>
          <Select id="filter-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="all">All severities</option>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor="filter-status">Review status</FieldLabel>
          <Select id="filter-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            {REVIEW_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      <p className="mt-3 font-mono text-xs text-stone-600 tabular-nums" role="status">
        Showing {filtered.length} of {findings.length} findings
      </p>

      {filtered.length === 0 ? (
        <div className="mt-3 flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-4 py-10 text-center">
          <SearchX className="h-5 w-5 text-stone-500" strokeWidth={1.5} aria-hidden />
          <p className="text-sm font-medium text-stone-800">
            {findings.length === 0 ? "No candidate findings" : "No findings match these filters"}
          </p>
          <p className="max-w-sm text-sm text-stone-600">
            {findings.length === 0
              ? "The document was analyzed and nothing was flagged. This is a screening result, not a clean bill of health."
              : "Try widening the filters to see more findings."}
          </p>
        </div>
      ) : (
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 overflow-x-auto rounded-lg border border-stone-200">
            <table className="w-full table-fixed text-left text-sm">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-xs font-medium text-stone-600">
                  <th className="w-20 px-3 py-2" scope="col">
                    Severity
                  </th>
                  <th className="px-3 py-2" scope="col">
                    Finding
                  </th>
                  <th className="w-24 px-3 py-2" scope="col">
                    Pages
                  </th>
                  <th className="w-36 px-3 py-2" scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f) => (
                  <tr
                    key={f.id}
                    role="button"
                    aria-pressed={selected?.id === f.id}
                    onClick={() => setSelectedId(f.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(f.id);
                      }
                    }}
                    tabIndex={0}
                    className={cn(
                      "cursor-pointer border-b border-stone-100 transition-colors duration-150 ease-app last:border-0 focus-visible:outline-2 focus-visible:outline-teal-700",
                      selected?.id === f.id ? "bg-teal-50" : "hover:bg-stone-50",
                    )}
                  >
                    <td className="px-3 py-2.5">
                      <SeverityBadge severity={f.severity} />
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="line-clamp-2 font-medium break-words text-stone-900">{f.title}</p>
                      <p className="mt-0.5 text-xs text-stone-600">
                        <CategoryLabel categoryId={f.category} />
                      </p>
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <Folio pageStart={f.pageStart} pageEnd={f.pageEnd} />
                    </td>
                    <td className="px-3 py-2.5">
                      <ReviewStatusBadge status={f.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <FindingDetail
              key={selected.id}
              documentId={documentId}
              finding={selected}
              onFindingUpdated={onFindingUpdated}
              onUnauthorized={onUnauthorized}
            />
          )}
        </div>
      )}
    </div>
  );
}

function FindingDetail({
  documentId,
  finding,
  onFindingUpdated,
  onUnauthorized,
}: {
  documentId: string;
  finding: StoredFinding;
  onFindingUpdated: (finding: StoredFinding) => void;
  onUnauthorized: () => void;
}) {
  const [note, setNote] = useState(finding.reviewerNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(patch: { status?: ReviewStatus; reviewerNote?: string | null }) {
    setSaving(true);
    setError(null);
    try {
      const res = await patchFinding(documentId, finding.id, patch);
      onFindingUpdated(res.finding);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="min-w-0 rounded-lg border border-stone-200 bg-white p-5" aria-label="Finding detail">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SeverityBadge severity={finding.severity} />
        <span className="text-[13px] text-stone-600">
          <CategoryLabel categoryId={finding.category} />
        </span>
        <ReviewStatusBadge status={finding.status} />
      </div>
      <h3 className="mt-2 font-display text-xl font-medium break-words text-stone-900">{finding.title}</h3>
      <p className="mt-2 text-sm leading-relaxed break-words text-stone-700">{finding.explanation}</p>

      <div className="mt-4 flex items-center gap-2">
        <h4 className="text-xs font-medium text-stone-600">Supporting evidence</h4>
        <Folio pageStart={finding.pageStart} pageEnd={finding.pageEnd} />
      </div>
      <blockquote className="mt-2 rounded-lg border border-stone-200 bg-stone-50 px-5 py-4 font-display text-[15px] leading-relaxed break-words text-stone-900">
        “{finding.evidence}”
      </blockquote>

      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-xs font-medium text-stone-600">Recommended reviewer action</dt>
          <dd className="mt-0.5 text-stone-700">{finding.recommendedAction}</dd>
        </div>
        <div className="flex gap-6 font-mono text-xs text-stone-600 tabular-nums">
          <span>
            Confidence:{" "}
            <span className="font-medium text-stone-800">
              {finding.confidence != null ? `${Math.round(finding.confidence * 100)}%` : "not reported"}
            </span>
          </span>
          <span>Model: {finding.modelId ?? "unknown"}</span>
        </div>
      </dl>

      <div className="mt-4 border-t border-stone-100 pt-4">
        <FieldLabel>Review decision</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {REVIEW_STATUS_OPTIONS.map((o) => (
            <Button
              key={o.value}
              variant={finding.status === o.value ? "primary" : "secondary"}
              size="sm"
              disabled={saving}
              onClick={() => void save({ status: o.value })}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <div className="mt-3">
          <FieldLabel htmlFor="reviewer-note">Reviewer note</FieldLabel>
          <TextArea
            id="reviewer-note"
            rows={2}
            className="w-full"
            placeholder="Add context for the deal team…"
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            disabled={saving || note === (finding.reviewerNote ?? "")}
            onClick={() => void save({ reviewerNote: note.trim() === "" ? null : note })}
          >
            {saving ? "Saving…" : "Save note"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-800">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
