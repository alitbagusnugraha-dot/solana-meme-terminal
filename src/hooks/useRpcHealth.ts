"use client";

import { useEffect, useState } from "react";
import { getConnection, toError } from "@/lib/rpc";
import { subscribeHeartbeat } from "@/lib/heartbeat";

export type RpcStatus = "checking" | "online" | "slow" | "offline";

export interface RpcHealth {
  status: RpcStatus;
  latencyMs: number | null;
  slot: number | null;
  checkedAt: number | null;
  error: string | null;
}

const CHECK_INTERVAL_MS = 10_000;
const SLOW_THRESHOLD_MS = 800;

/** Cek kesehatan Helius RPC (getSlot) tiap 10 detik dan ukur latensinya. */
export function useRpcHealth(): RpcHealth {
  const [health, setHealth] = useState<RpcHealth>({
    status: "checking",
    latencyMs: null,
    slot: null,
    checkedAt: null,
    error: null,
  });

  useEffect(() => {
    let active = true;
    let running = false;
    let lastCheck = 0;

    const check = async () => {
      running = true;
      const started = performance.now();
      try {
        const slot = await getConnection().getSlot("confirmed");
        const latencyMs = Math.round(performance.now() - started);
        if (active) {
          setHealth({
            status: latencyMs > SLOW_THRESHOLD_MS ? "slow" : "online",
            latencyMs,
            slot,
            checkedAt: Date.now(),
            error: null,
          });
        }
      } catch (error) {
        if (active) {
          setHealth((previous) => ({
            status: "offline",
            latencyMs: null,
            slot: previous.slot,
            checkedAt: Date.now(),
            error: toError(error).message,
          }));
        }
      } finally {
        running = false;
      }
    };

    const unsubscribe = subscribeHeartbeat((now) => {
      if (running || now - lastCheck < CHECK_INTERVAL_MS) return;
      lastCheck = now;
      void check();
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return health;
}
