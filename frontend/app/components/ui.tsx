import type { ButtonHTMLAttributes, ReactNode } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-slate-100 text-slate-700",
  success: "bg-emerald-100 text-emerald-800",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-red-100 text-red-800",
  info: "bg-blue-100 text-blue-800",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-700",
  secondary: "border border-slate-300 bg-white hover:bg-slate-100",
  danger: "bg-red-700 text-white hover:bg-red-600",
};

const BUTTON_SIZES = {
  md: "px-4 py-2 text-sm",
  sm: "px-3 py-1 text-sm",
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: keyof typeof BUTTON_SIZES;
}

export function Button({ variant = "secondary", size = "md", className = "", ...props }: ButtonProps) {
  return (
    <button
      type="button"
      className={`rounded-md font-medium transition-colors disabled:opacity-50 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800 ${className}`}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-600">{description}</p>
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({
  label,
  description,
  action,
  children,
}: {
  label: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{label}</h2>
          {description !== undefined && (
            <p className="mt-0.5 text-sm text-slate-600">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-slate-900">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{body}</p>
    </div>
  );
}

export function ErrorBlock({
  message,
  onRetry,
  retryLabel = "Retry",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3" role="alert">
      <p className="text-sm text-red-800">{message}</p>
      {onRetry !== undefined && (
        <Button variant="primary" size="sm" onClick={onRetry} className="mt-3">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export function LoadingLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-slate-600" role="status">
      {children}
    </p>
  );
}

export function Toast({
  tone,
  title,
  body,
  actionLabel,
  onAction,
  onDismiss,
}: {
  tone: "success" | "danger";
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
  onDismiss: () => void;
}) {
  const iconColor = tone === "success" ? "text-emerald-600" : "text-red-600";
  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 shrink-0 ${iconColor}`} aria-hidden="true">
          {tone === "success" ? (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="m6.5 10.2 2.4 2.4 4.6-5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 2.5 17.5 16.5h-15L10 2.5Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path d="M10 7.5v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="10" cy="13.8" r="0.9" fill="currentColor" />
            </svg>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          <p className="mt-0.5 truncate text-sm text-slate-600" title={body}>
            {body}
          </p>
          <button
            type="button"
            onClick={onAction}
            className="mt-2 rounded text-[13px] font-medium text-blue-800 hover:text-blue-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
          >
            {actionLabel}
          </button>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="rounded px-1 text-base leading-none text-slate-400 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-800"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function ProgressBar({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  const percent =
    max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-slate-200"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div className="h-2 rounded-full bg-blue-800" style={{ width: `${percent}%` }} />
    </div>
  );
}
