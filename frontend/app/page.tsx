"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDate } from "@/lib/format";
import {
  MATTER_DESCRIPTION_MAX_LENGTH,
  MATTER_STATUS_LABELS,
  MATTER_TITLE_MAX_LENGTH,
  createMatter,
  listMatters,
  validateMatterForm,
  type Matter,
  type MatterStatus,
} from "@/lib/matters";

const API_URL = process.env["NEXT_PUBLIC_API_URL"];

type ListState =
  | { status: "loading" }
  | { status: "ready"; matters: Matter[] }
  | { status: "error"; message: string };

const STATUS_BADGE: Record<MatterStatus, string> = {
  active: "bg-emerald-100 text-emerald-800",
  on_hold: "bg-amber-100 text-amber-800",
  completed: "bg-zinc-200 text-zinc-700",
};

export default function MattersPage() {
  // Both server and client render this identical initial state, so hydration
  // always matches; the effect below only subscribes for client-side data.
  const [list, setList] = useState<ListState>(() =>
    API_URL === undefined || API_URL === ""
      ? { status: "error", message: "NEXT_PUBLIC_API_URL is not configured." }
      : { status: "loading" },
  );
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

  const loadMatters = (apiUrl: string | undefined) => {
    setList({ status: "loading" });
    if (apiUrl === undefined || apiUrl === "") {
      setList({
        status: "error",
        message: "NEXT_PUBLIC_API_URL is not configured.",
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
          message: err instanceof Error ? err.message : "Could not load matters.",
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
              err instanceof Error ? err.message : "Could not load matters.",
          });
        },
      );
    }
  }, []);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (API_URL === undefined || API_URL === "") {
      setSubmitError("NEXT_PUBLIC_API_URL is not configured.");
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
          err instanceof Error ? err.message : "Could not create the matter.",
        );
      },
    );
  };

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-bold tracking-tight">Matters</h1>
      <p className="mt-1 text-sm text-zinc-600">
        Track audit matters. Records are stored in MongoDB.
      </p>

      <section aria-label="Matters" className="mt-8">
        {list.status === "loading" && (
          <p className="text-sm text-zinc-600" role="status">
            Loading matters…
          </p>
        )}
        {list.status === "error" && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-800">{list.message}</p>
            <button
              type="button"
              onClick={() => loadMatters(API_URL)}
              className="mt-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              Retry
            </button>
          </div>
        )}
        {list.status === "ready" &&
          (list.matters.length === 0 ? (
            <p className="rounded-md border border-zinc-200 px-4 py-6 text-center text-sm text-zinc-600">
              No matters yet. Create the first one below.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200">
              {list.matters.map((matter) => (
                <li
                  key={matter.id}
                  className="flex items-start justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/matters/${matter.id}`}
                      className="truncate font-medium underline hover:text-zinc-700"
                    >
                      {matter.title}
                    </Link>
                    <p className="mt-0.5 text-sm text-zinc-600">
                      Created {formatDate(matter.createdAt)}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[matter.status]}`}
                  >
                    {MATTER_STATUS_LABELS[matter.status]}
                  </span>
                </li>
              ))}
            </ul>
          ))}
      </section>

      <section aria-label="Create a matter" className="mt-10">
        <h2 className="text-lg font-semibold">New matter</h2>
        <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
          <div>
            <label
              htmlFor="matter-title"
              className="block text-sm font-medium"
            >
              Title
            </label>
            <input
              id="matter-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              placeholder="e.g. Smith merger review"
              aria-invalid={fieldErrors.title !== undefined}
            />
            <p className="mt-1 text-xs text-zinc-500">
              {title.trim().length}/{MATTER_TITLE_MAX_LENGTH} characters
            </p>
            {fieldErrors.title !== undefined && (
              <p className="mt-1 text-sm text-red-700" role="alert">
                {fieldErrors.title}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="matter-description"
              className="block text-sm font-medium"
            >
              Description <span className="font-normal">(optional)</span>
            </label>
            <textarea
              id="matter-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
              aria-invalid={fieldErrors.description !== undefined}
            />
            <p className="mt-1 text-xs text-zinc-500">
              {description.length}/{MATTER_DESCRIPTION_MAX_LENGTH} characters
            </p>
            {fieldErrors.description !== undefined && (
              <p className="mt-1 text-sm text-red-700" role="alert">
                {fieldErrors.description}
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="matter-status"
              className="block text-sm font-medium"
            >
              Status
            </label>
            <select
              id="matter-status"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as MatterStatus)
              }
              className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm sm:w-56"
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
              Matter created.
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create matter"}
          </button>
        </form>
      </section>
    </main>
  );
}
