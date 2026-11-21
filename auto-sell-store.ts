/**
 * Aturan Auto Take-Profit / Stop-Loss / Trailing Stop per wallet + mint.
 * Disimpan di localStorage, termasuk status level yang sudah tereksekusi dan
 * harga puncak trailing — reload halaman tidak membuat TP tereksekusi dua kali.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface TakeProfitLevel {
  id: string;
  /** Contoh 100 = +100% dari harga masuk. */
  triggerPct: number;
  /** Persentase saldo token SAAT ITU yang dijual. */
  sellPct: number;
  done: boolean;
  doneAt: number | null;
  signature: string | null;
}

export interface StopLossConfig {
  /** Angka positif. 30 = jual saat harga −30% dari harga masuk. */
  triggerPct: number;
  sellPct: number;
  done: boolean;
  doneAt: number | null;
  signature: string | null;
}

export interface TrailingStopConfig {
  /** Trailing aktif setelah PnL mencapai angka ini (%). 0 = langsung aktif. */
  activatePct: number;
  /** Jual saat harga turun sejauh ini (%) dari harga puncak. */
  distancePct: number;
  sellPct: number;
  armed: boolean;
  peakPriceSol: number | null;
  done: boolean;
  doneAt: number | null;
  signature: string | null;
}

export interface AutoSellRule {
  key: string;
  wallet: string;
  mint: string;
  symbol: string | null;
  enabled: boolean;
  takeProfits: TakeProfitLevel[];
  stopLoss: StopLossConfig | null;
  trailing: TrailingStopConfig | null;
  /** Slippage khusus auto-sell (bps). Biasanya lebih tinggi dari trading manual. */
  slippageBps: number;
  /** Bila diisi, dipakai sebagai harga masuk (untuk token yang dibeli di luar terminal). */
  manualEntryPriceSol: number | null;
  failures: number;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt: number | null;
}

export interface AutoSellRuleInput {
  wallet: string;
  mint: string;
  symbol: string | null;
  enabled: boolean;
  takeProfits: { triggerPct: number; sellPct: number }[];
  stopLoss: { triggerPct: number; sellPct: number } | null;
  trailing: { activatePct: number; distancePct: number; sellPct: number } | null;
  slippageBps: number;
  manualEntryPriceSol: number | null;
}

export type TriggerKind = "take-profit" | "stop-loss" | "trailing";

export function ruleKey(wallet: string, mint: string): string {
  return `${wallet}:${mint}`;
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `tp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface AutoSellState {
  rules: Record<string, AutoSellRule>;
  upsertRule: (input: AutoSellRuleInput) => AutoSellRule;
  setEnabled: (key: string, enabled: boolean) => void;
  removeRule: (key: string) => void;
  resetProgress: (key: string) => void;
  updateTrailing: (key: string, patch: { armed: boolean; peakPriceSol: number | null }) => void;
  markTriggered: (key: string, kind: TriggerKind, levelId: string | null, signature: string) => void;
  recordFailure: (key: string) => number;
  resetFailures: (key: string) => void;
}

export const useAutoSellStore = create<AutoSellState>()(
  persist(
    (set, get) => ({
      rules: {},

      upsertRule: (input) => {
        const key = ruleKey(input.wallet, input.mint);
        const now = Date.now();
        const existing = get().rules[key];
        const rule: AutoSellRule = {
          key,
          wallet: input.wallet,
          mint: input.mint,
          symbol: input.symbol,
          enabled: input.enabled,
          takeProfits: [...input.takeProfits]
            .sort((a, b) => a.triggerPct - b.triggerPct)
            .map((level) => ({ id: newId(), ...level, done: false, doneAt: null, signature: null })),
          stopLoss: input.stopLoss ? { ...input.stopLoss, done: false, doneAt: null, signature: null } : null,
          trailing: input.trailing
            ? { ...input.trailing, armed: input.trailing.activatePct <= 0, peakPriceSol: null, done: false, doneAt: null, signature: null }
            : null,
          slippageBps: input.slippageBps,
          manualEntryPriceSol: input.manualEntryPriceSol,
          failures: 0,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastTriggeredAt: null,
        };
        set((state) => ({ rules: { ...state.rules, [key]: rule } }));
        return rule;
      },

      setEnabled: (key, enabled) =>
        set((state) => {
          const rule = state.rules[key];
          if (!rule) return state;
          return { rules: { ...state.rules, [key]: { ...rule, enabled, failures: enabled ? 0 : rule.failures, updatedAt: Date.now() } } };
        }),

      removeRule: (key) =>
        set((state) => {
          const next = { ...state.rules };
          delete next[key];
          return { rules: next };
        }),

      resetProgress: (key) =>
        set((state) => {
          const rule = state.rules[key];
          if (!rule) return state;
          return {
            rules: {
              ...state.rules,
              [key]: {
                ...rule,
                takeProfits: rule.takeProfits.map((level) => ({ ...level, done: false, doneAt: null, signature: null })),
                stopLoss: rule.stopLoss ? { ...rule.stopLoss, done: false, doneAt: null, signature: null } : null,
                trailing: rule.trailing
                  ? {
                      ...rule.trailing,
                      armed: rule.trailing.activatePct <= 0,
                      peakPriceSol: null,
                      done: false,
                      doneAt: null,
                      signature: null,
                    }
                  : null,
                failures: 0,
                lastTriggeredAt: null,
                updatedAt: Date.now(),
              },
            },
          };
        }),

      updateTrailing: (key, patch) =>
        set((state) => {
          const rule = state.rules[key];
          if (!rule?.trailing) return state;
          if (rule.trailing.armed === patch.armed && rule.trailing.peakPriceSol === patch.peakPriceSol) return state;
          return { rules: { ...state.rules, [key]: { ...rule, trailing: { ...rule.trailing, ...patch } } } };
        }),

      markTriggered: (key, kind, levelId, signature) =>
        set((state) => {
          const rule = state.rules[key];
          if (!rule) return state;
          const now = Date.now();
          const updated: AutoSellRule = { ...rule, lastTriggeredAt: now, failures: 0, updatedAt: now };
          if (kind === "take-profit") {
            updated.takeProfits = rule.takeProfits.map((level) =>
              level.id === levelId ? { ...level, done: true, doneAt: now, signature } : level,
            );
          } else if (kind === "stop-loss" && rule.stopLoss) {
            updated.stopLoss = { ...rule.stopLoss, done: true, doneAt: now, signature };
          } else if (kind === "trailing" && rule.trailing) {
            updated.trailing = { ...rule.trailing, done: true, doneAt: now, signature };
          }
          return { rules: { ...state.rules, [key]: updated } };
        }),

      recordFailure: (key) => {
        const rule = get().rules[key];
        if (!rule) return 0;
        const failures = rule.failures + 1;
        set((state) => ({ rules: { ...state.rules, [key]: { ...rule, failures, updatedAt: Date.now() } } }));
        return failures;
      },

      resetFailures: (key) =>
        set((state) => {
          const rule = state.rules[key];
          if (!rule || rule.failures === 0) return state;
          return { rules: { ...state.rules, [key]: { ...rule, failures: 0 } } };
        }),
    }),
    {
      name: "smt:auto-sell:v1",
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ rules: state.rules }),
    },
  ),
);
