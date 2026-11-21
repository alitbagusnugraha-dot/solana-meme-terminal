/**
 * Pengaturan terminal — disimpan di localStorage (tanpa data rahasia).
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_SWAP_SETTINGS, type SwapSettings } from "@/lib/swap";

export interface SettingsState {
  swap: SwapSettings;
  buyPresetsSol: number[];
  sellPresetsPct: number[];
  /** Slippage minimum untuk tombol Panic Sell (bps). */
  panicSlippageBps: number;
  /** Menit tanpa aktivitas sebelum wallet dikunci. 0 = nonaktif. */
  autoLockMinutes: number;
  /** Saat ada aturan Auto TP/SL aktif, jangan kunci wallet otomatis (agar mesin tetap bisa menandatangani). */
  keepUnlockedWhileAutoSell: boolean;
  autoSellEngineEnabled: boolean;
  soundEnabled: boolean;
  lastMint: string | null;

  setSwap: (patch: Partial<SwapSettings>) => void;
  setPanicSlippageBps: (bps: number) => void;
  setAutoLockMinutes: (minutes: number) => void;
  setKeepUnlockedWhileAutoSell: (value: boolean) => void;
  setAutoSellEngineEnabled: (value: boolean) => void;
  setSoundEnabled: (value: boolean) => void;
  setLastMint: (mint: string | null) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      swap: { ...DEFAULT_SWAP_SETTINGS },
      buyPresetsSol: [0.05, 0.1, 0.5, 1],
      sellPresetsPct: [25, 50, 75, 100],
      panicSlippageBps: 3_000,
      autoLockMinutes: 30,
      keepUnlockedWhileAutoSell: true,
      autoSellEngineEnabled: true,
      soundEnabled: true,
      lastMint: null,

      setSwap: (patch) => set((state) => ({ swap: { ...state.swap, ...patch } })),
      setPanicSlippageBps: (bps) => set({ panicSlippageBps: Math.min(10_000, Math.max(1, Math.round(bps))) }),
      setAutoLockMinutes: (minutes) => set({ autoLockMinutes: Math.max(0, Math.round(minutes)) }),
      setKeepUnlockedWhileAutoSell: (value) => set({ keepUnlockedWhileAutoSell: value }),
      setAutoSellEngineEnabled: (value) => set({ autoSellEngineEnabled: value }),
      setSoundEnabled: (value) => set({ soundEnabled: value }),
      setLastMint: (mint) => set({ lastMint: mint }),
    }),
    {
      name: "smt:settings:v1",
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...saved,
          swap: { ...current.swap, ...(saved.swap ?? {}) },
        };
      },
    },
  ),
);
