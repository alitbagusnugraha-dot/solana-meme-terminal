"use client";

import { useSyncExternalStore } from "react";
import { subscribeHeartbeat } from "@/lib/heartbeat";

let currentNow = 0;

function subscribe(onChange: () => void): () => void {
  return subscribeHeartbeat((now) => {
    currentNow = now;
    onChange();
  });
}

function getSnapshot(): number {
  if (currentNow === 0) currentNow = Date.now();
  return currentNow;
}

function getServerSnapshot(): number {
  return 0;
}

/** Waktu sekarang yang ikut berdetak tiap ±1 detik (untuk teks "x dtk lalu"). */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
