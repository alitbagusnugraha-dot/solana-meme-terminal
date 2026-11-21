/**
 * Toast notifikasi (pojok kanan bawah).
 */

import { create } from "zustand";

export type ToastKind = "success" | "error" | "info" | "warning" | "take-profit" | "stop-loss";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  message?: string;
  href?: string;
  hrefLabel?: string;
  createdAt: number;
  durationMs: number;
}

export interface ToastInput {
  kind: ToastKind;
  title: string;
  message?: string;
  href?: string;
  hrefLabel?: string;
  durationMs?: number;
}

interface ToastState {
  toasts: Toast[];
  push: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const MAX_TOASTS = 6;
let counter = 0;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (input) => {
    counter += 1;
    const id = `toast-${Date.now()}-${counter}`;
    const durationMs = input.durationMs ?? (input.kind === "error" ? 9_000 : 6_000);
    const toast: Toast = { ...input, id, createdAt: Date.now(), durationMs };
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));
    if (durationMs > 0) {
      setTimeout(() => get().dismiss(id), durationMs);
    }
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function pushToast(input: ToastInput): string {
  return useToastStore.getState().push(input);
}
