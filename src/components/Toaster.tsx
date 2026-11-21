"use client";

import { useToastStore, type ToastKind } from "@/store/toast-store";
import { cn } from "./ui";

const KIND_STYLE: Record<ToastKind, { border: string; icon: string; title: string }> = {
  success: { border: "border-up/50", icon: "✓", title: "text-up" },
  error: { border: "border-down/60", icon: "!", title: "text-down" },
  info: { border: "border-line-strong", icon: "i", title: "text-fg" },
  warning: { border: "border-warn/60", icon: "⚠", title: "text-warn" },
  "take-profit": { border: "border-up", icon: "▲", title: "text-up" },
  "stop-loss": { border: "border-down", icon: "▼", title: "text-down" },
};

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-3 right-3 z-[60] flex w-[min(380px,calc(100vw-24px))] flex-col gap-2">
      {toasts.map((toast) => {
        const style = KIND_STYLE[toast.kind];
        return (
          <div
            key={toast.id}
            className={cn(
              "pointer-events-auto rounded-lg border bg-panel/95 p-3 shadow-xl backdrop-blur",
              style.border,
              (toast.kind === "take-profit" || toast.kind === "stop-loss") && "animate-[pulse_1.2s_ease-in-out_2]",
            )}
          >
            <div className="flex items-start gap-2">
              <span className={cn("mt-0.5 font-mono text-xs font-bold", style.title)}>{style.icon}</span>
              <div className="min-w-0 flex-1">
                <div className={cn("text-xs font-semibold", style.title)}>{toast.title}</div>
                {toast.message ? <div className="mt-0.5 break-words text-xs text-muted">{toast.message}</div> : null}
                {toast.href ? (
                  <a
                    href={toast.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-1 inline-block text-[11px] text-accent hover:underline"
                  >
                    {toast.hrefLabel ?? "Buka"} ↗
                  </a>
                ) : null}
              </div>
              <button type="button" aria-label="Tutup" className="text-xs text-dim hover:text-fg" onClick={() => dismiss(toast.id)}>
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
