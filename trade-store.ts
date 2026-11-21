/**
 * Status transaksi yang sedang berjalan + riwayat singkat hasil terakhir.
 */

import { create } from "zustand";
import type { SwapSide, SwapStage } from "@/lib/swap";

export type TradeSource = "manual" | "panic" | "auto-tp" | "auto-sl" | "auto-trailing";

export interface ActiveTrade {
  id: string;
  mint: string;
  symbol: string | null;
  side: SwapSide;
  source: TradeSource;
  stage: SwapStage;
  message: string;
  startedAt: number;
  signature: string | null;
}

export interface TradeSummary {
  id: string;
  mint: string;
  symbol: string | null;
  side: SwapSide;
  source: TradeSource;
  ok: boolean;
  message: string;
  signature: string | null;
  explorerUrl: string | null;
  totalMs: number | null;
  finishedAt: number;
}

interface TradeState {
  active: Record<string, ActiveTrade>;
  history: TradeSummary[];
  start: (trade: ActiveTrade) => void;
  update: (id: string, patch: Partial<Pick<ActiveTrade, "stage" | "message" | "signature">>) => void;
  finish: (id: string, summary: TradeSummary) => void;
}

export const useTradeStore = create<TradeState>()((set) => ({
  active: {},
  history: [],
  start: (trade) => set((state) => ({ active: { ...state.active, [trade.id]: trade } })),
  update: (id, patch) =>
    set((state) => {
      const current = state.active[id];
      if (!current) return state;
      return { active: { ...state.active, [id]: { ...current, ...patch } } };
    }),
  finish: (id, summary) =>
    set((state) => {
      const next = { ...state.active };
      delete next[id];
      return { active: next, history: [summary, ...state.history].slice(0, 30) };
    }),
}));
