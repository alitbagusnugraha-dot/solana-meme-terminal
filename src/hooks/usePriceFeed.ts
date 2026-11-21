"use client";

import { useEffect, useSyncExternalStore } from "react";
import { priceFeed, type PriceSnapshot } from "@/lib/price-feed";

/**
 * Berlangganan harga live untuk daftar mint. Banyak komponen boleh memanggil hook
 * ini sekaligus — price feed menggabungkan semuanya ke satu polling.
 */
export function usePriceFeed(mints: readonly (string | null | undefined)[]): PriceSnapshot {
  const key = [...new Set(mints.filter((mint): mint is string => Boolean(mint)))].sort().join(",");

  useEffect(() => {
    if (!key) return undefined;
    return priceFeed.track(key.split(","));
  }, [key]);

  return useSyncExternalStore(priceFeed.subscribe, priceFeed.getSnapshot, priceFeed.getServerSnapshot);
}
