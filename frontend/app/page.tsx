"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDate } from "@/lib/format";
import { useNavBusy } from "./components/useNavBusy";
import {
  APP_CONFIG_ERROR_MESSAGE,
  MATTER_DESCRIPTION_MAX_LENGTH,
  MATTER_STATUS_LABELS,
  MATTER_TITLE_MAX_LENGTH,
  createMatter,
  deleteMatter,
  listMatters,
  validateMatterForm,
  type Matter,
  type MatterStatus,
} from "@/lib/matters";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBlock,
  LoadingLine,
  PageHeader,
  Section,
  type BadgeTone,
} from "./components/ui";

const API_URL = process.env["NEXT_PUBLIC_API_URL"];

type ListState =
  | { status: "loading" }
  | { status: "ready"; matters: Matter[] }
  | { status: "error"; message: string };

const STATUS_TONE: Record<MatterStatus, BadgeTone> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};

export default function MattersPage() {
  // Both server and client render this identical initial state, so hydration
  // always matches; the effect below only subscribes for client-side data.
  const [list, setList] = useState<ListState>(() =>
    API_URL === undefined || API_URL === ""
      ? { status: "error", message: APP_CONFIG_ERROR_MESSAGE }
      : { status: "loading" },
  );
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<MatterStatus>("active");
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    description?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { navBusy, guardNav } = useNavBusy();
  const navClass = (base: string): string =>
    navBusy ? `${base} pointer-events-none opacity-60` : base;

  const loadMatters = (apiUrl: string | undefined) => {
    setList({ status: "loading" });
    if (apiUrl === undefined || apiUrl === "") {
      setList({
        status: "error",
        message: APP_CONFIG_ERROR_MESSAGE,
      });
      return;
    }
    listMatters(apiUrl).then(
      (matters) => {
        setList({ status: "ready", matters });
      },
      (err: unknown) => {
        setList({
          status: "error",
          message:
            err instanceof Error ? err.message : "Couldn't load matters. Please try again.",
        });
      },
    );
  };

  useEffect(() => {
    if (API_URL !== undefined && API_URL !== "") {
      const apiUrl: string = API_URL;
      listMatters(apiUrl).then(
        (matters) => {
          setList({ status: "ready", matters });
        },
        (err: unknown) => {
          setList({
            status: "error",
            message:
              err instanceof Error ? err.message : "Couldn't load matters. Please try again.",
          });
        },
      );
    }
  }, []);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (API_URL === undefined || API_URL === "") {
      setSubmitError(APP_CONFIG_ERROR_MESSAGE);
      return;
    }
    const errors = validateMatterForm({ title, description });
    setFieldErrors(errors);
    if (errors.title !== undefined || errors.description !== undefined) {
      return;
    }
    const apiUrl: string = API_URL;
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);
    createMatter(apiUrl, {
      title: title.trim(),
      description: description === "" ? undefined : description,
      status,
    }).then(
      () => {
        setSubmitting(false);
        setTitle("");
        setDescription("");
        setStatus("active");
        setFieldErrors({});
        setSubmitSuccess(true);
        loadMatters(apiUrl);
      },
      (err: unknown) => {
        setSubmitting(false);
        setSubmitError(
          err instanceof Error ? err.message : "Couldn't create that matter. Please try again.",
        );
      },
    );
  };

  const onDelete = async (matter: Matter) => {
    if (API_URL === undefined || API_URL === "") {
      return;
    }
    setDeletingId(matter.id);
    setDeleteError(null);
    try {
      await deleteMatter(API_URL, matter.id);
      setConfirmDeleteId(null);
      loadMatters(API_URL);
    } catch (err: unknown) {
      setDeleteError(
        err instanceof Error ? err.message : "Couldn't delete this matter. Please try again.",
      );
      loadMatters(API_URL);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        title="Matters"
        description="Deals and engagements under review. Each matter groups the documents for one due-diligence effort."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setShowForm((open) => !open);
              setSubmitError(null);
              setSubmitSuccess(false);
            }}
            aria-expanded={showForm}
          >
            {showForm ? "Close" : "New matter"}
          </Button>
        }
      />

      {showForm && (
        <section aria-label="Create a matter" className="mt-6 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="text-base font-semibold text-slate-900">New matter</h2>
          <form onSubmit={onSubmit} className="mt-4 max-w-2xl space-y-4" noValidate>
            <div>
              <label htmlFor="matter-title" className="block text-sm font-medium text-slate-900">
                Deal name
              </label>
              <input
                id="matter-title"
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
                placeholder="e.g. ABC Technologies Acquisition"
                aria-invalid={fieldErrors.title !== undefined}
              />
              <p className="mt-1 text-xs tabular-nums text-slate-500">
                {title.trim().length}/{MATTER_TITLE_MAX_LENGTH} characters
              </p>
              {fieldErrors.title !== undefined && (
                <p className="mt-1 text-sm text-red-700" role="alert">
                  {fieldErrors.title}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="matter-description" className="block text-sm font-medium text-slate-900">
                Description <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <textarea
                id="matter-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800"
                aria-invalid={fieldErrors.description !== undefined}
              />
              <p className="mt-1 text-xs tabular-nums text-slate-500">
                {description.length}/{MATTER_DESCRIPTION_MAX_LENGTH} characters
              </p>
              {fieldErrors.description !== undefined && (
                <p className="mt-1 text-sm text-red-700" role="alert">
                  {fieldErrors.description}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="matter-status" className="block text-sm font-medium text-slate-900">
                Status
              </label>
              <select
                id="matter-status"
                value={status}
                onChange={(event) => setStatus(event.target.value as MatterStatus)}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-800 sm:w-56"
              >
                <option value="active">Active</option>
                <option value="on_hold">On hold</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            {submitError !== null && (
              <p className="text-sm text-red-700" role="alert">
                {submitError}
              </p>
            )}
            {submitSuccess && (
              <p className="text-sm text-emerald-700" role="status">
                Matter created
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button variant="primary" type="submit" disabled={submitting}>
                {submitting ? "Creating…" : "Create matter"}
              </Button>
              <Button
                onClick={() => {
                  setShowForm(false);
                  setSubmitError(null);
                  setSubmitSuccess(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </section>
      )}

      <Section label="All matters">
        {list.status === "loading" && <LoadingLine>Loading matters…</LoadingLine>}
        {list.status === "error" && (
          <ErrorBlock message={list.message} onRetry={() => loadMatters(API_URL)} />
        )}
        {list.status === "ready" &&
          (list.matters.length === 0 ? (
            <EmptyState
              title="No matters yet"
              body="A matter represents one deal or engagement. Create one to start collecting and reviewing its due-diligence documents."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Matter
                    </th>
                    <th scope="col" className="w-32 px-4 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="w-36 px-4 py-2.5 font-medium">
                      Updated
                    </th>
                    <th scope="col" className="w-36 px-4 py-2.5 text-right font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {list.matters.map((matter) => (
                    <tr key={matter.id} className="hover:bg-slate-50">
                      <td className="max-w-0 px-4 py-3">
                        <Link
                          href={`/matters/${matter.id}`}
                          onClick={guardNav}
                          aria-disabled={navBusy}
                          className={navClass(
                            "block truncate font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800",
                          )}
                        >
                          {matter.title}
                        </Link>
                        {matter.description !== undefined && matter.description !== "" && (
                          <p className="mt-0.5 truncate text-[13px] text-slate-600">
                            {matter.description}
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Badge tone={STATUS_TONE[matter.status]}>
                          {MATTER_STATUS_LABELS[matter.status]}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-[13px] tabular-nums text-slate-600">
                        {formatDate(matter.updatedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[13px] font-medium">
                          <Link
                            href={`/matters/${matter.id}`}
                            aria-label={`Open ${matter.title}`}
                            onClick={guardNav}
                            aria-disabled={navBusy}
                            className={navClass(
                              "rounded text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800",
                            )}
                          >
                            Open →
                          </Link>
                          {confirmDeleteId === matter.id ? (
                            <>
                              <button
                                type="button"
                                disabled={deletingId === matter.id}
                                onClick={() => void onDelete(matter)}
                                className="rounded font-semibold text-red-700 hover:text-red-800 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                              >
                                {deletingId === matter.id ? "Deleting…" : "Confirm"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteError(null);
                                setConfirmDeleteId(matter.id);
                              }}
                              className="rounded text-slate-600 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {deleteError !== null && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {deleteError}
          </p>
        )}
      </Section>
    </main>
  );
}
