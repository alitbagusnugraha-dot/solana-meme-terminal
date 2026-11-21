"use client";

import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "buy" | "sell" | "outline" | "ghost" | "danger" | "subtle";
type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent/85 border border-accent",
  buy: "bg-up text-black hover:bg-up-strong border border-up font-semibold",
  sell: "bg-down text-white hover:bg-down-strong border border-down font-semibold",
  outline: "border border-line-strong text-fg hover:border-muted hover:bg-panel-2",
  ghost: "text-muted hover:text-fg hover:bg-panel-2 border border-transparent",
  danger: "border border-down/60 text-down hover:bg-down/10",
  subtle: "bg-panel-2 text-fg border border-line hover:border-line-strong",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px] rounded",
  sm: "h-7 px-2.5 text-xs rounded-md",
  md: "h-9 px-3 text-sm rounded-md",
  lg: "h-11 px-4 text-sm rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  active?: boolean;
}

export function Button({
  variant = "outline",
  size = "md",
  loading = false,
  active = false,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        active && "ring-1 ring-accent",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent", className)}
    />
  );
}

// ---------------------------------------------------------------------------
// Input & Field
// ---------------------------------------------------------------------------

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-line bg-bg px-2.5 text-sm text-fg placeholder:text-dim",
        "focus:border-accent focus:outline-none disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-dim">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-lg border border-line bg-panel", className)}>
      {title || right ? (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="truncate text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
          {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
        </header>
      ) : null}
      <div className={cn("min-w-0 p-3", bodyClassName)}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

type BadgeTone = "up" | "down" | "warn" | "neutral" | "accent";

const BADGE_CLASS: Record<BadgeTone, string> = {
  up: "border-up/40 bg-up/10 text-up",
  down: "border-down/40 bg-down/10 text-down",
  warn: "border-warn/40 bg-warn/10 text-warn",
  neutral: "border-line-strong bg-panel-2 text-muted",
  accent: "border-accent/40 bg-accent/10 text-accent",
};

export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium",
        BADGE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-xs text-fg", disabled && "cursor-not-allowed opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
          checked ? "border-up bg-up/30" : "border-line-strong bg-panel-2",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all",
            checked ? "left-[18px] bg-up" : "left-0.5 bg-muted",
          )}
        />
      </button>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cn("w-full rounded-xl border border-line-strong bg-panel shadow-2xl", width)}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <button type="button" aria-label="Tutup" className="text-muted hover:text-fg" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="max-h-[75vh] overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat
// ---------------------------------------------------------------------------

export function Stat({
  label,
  value,
  tone = "flat",
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: "up" | "down" | "flat";
  sub?: ReactNode;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-bg/60 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div
        className={cn(
          "truncate font-mono text-sm tabular-nums",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          tone === "flat" && "text-fg",
        )}
      >
        {value}
      </div>
      {sub ? <div className="truncate text-[10px] text-dim">{sub}</div> : null}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard?.writeText(value).catch(() => undefined);
      }}
      title="Salin ke clipboard"
    >
      ⧉ {label}
    </Button>
  );
}
