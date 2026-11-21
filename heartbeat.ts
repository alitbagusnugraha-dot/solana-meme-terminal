/**
 * src/lib/heartbeat.ts — Satu detak jantung (±1 detik) untuk seluruh terminal.
 *
 * Memakai Web Worker (/workers/heartbeat.js) agar tidak diperlambat browser saat
 * tab di background. Jika Worker gagal dibuat, otomatis kembali ke setInterval biasa.
 */

export type HeartbeatListener = (now: number) => void;

const BASE_INTERVAL_MS = 1_000;
const listeners = new Set<HeartbeatListener>();

let worker: Worker | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let usingWorker = false;

function emit(now: number): void {
  for (const listener of listeners) {
    try {
      listener(now);
    } catch (error) {
      console.error("[heartbeat] listener error", error);
    }
  }
}

function startFallback(): void {
  if (fallbackTimer !== null) return;
  usingWorker = false;
  fallbackTimer = setInterval(() => emit(Date.now()), BASE_INTERVAL_MS);
}

function start(): void {
  if (typeof window === "undefined") return;
  if (typeof Worker === "function") {
    try {
      worker = new Worker("/workers/heartbeat.js");
      worker.onmessage = (event: MessageEvent<{ type?: string; at?: number }>) => {
        if (event.data?.type === "tick") emit(Date.now());
      };
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        startFallback();
      };
      worker.postMessage({ type: "start", interval: BASE_INTERVAL_MS });
      usingWorker = true;
      return;
    } catch {
      worker = null;
    }
  }
  startFallback();
}

function stop(): void {
  if (worker) {
    worker.postMessage({ type: "stop" });
    worker.terminate();
    worker = null;
  }
  if (fallbackTimer !== null) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  usingWorker = false;
}

export function subscribeHeartbeat(listener: HeartbeatListener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function isHeartbeatUsingWorker(): boolean {
  return usingWorker;
}
