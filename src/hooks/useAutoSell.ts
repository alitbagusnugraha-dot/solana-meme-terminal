"use client";

/**
 * src/hooks/useAutoSell.ts — Mesin Auto Take-Profit, Stop-Loss & Trailing Stop
 *
 * Cara kerja:
 * 1. Setiap aturan aktif mendaftarkan mint-nya ke price feed (DexScreener, polling 2 dtk
 *    lewat heartbeat Web Worker — tetap berdetak walau tab di background).
 * 2. Setiap data harga BARU masuk, PnL dihitung terhadap harga masuk:
 *      harga masuk = harga manual (bila diisi) ATAU harga beli rata-rata dari jurnal
 *      (sudah termasuk fee & tip, jadi TP +100% = untung bersih +100%).
 * 3. Urutan prioritas per tick: STOP-LOSS → TRAILING STOP → TAKE-PROFIT (lindungi modal dulu).
 * 4. Konfirmasi anti-glitch: TP harus terpenuhi 2 tick berturut-turut; SL & trailing 1 tick
 *    (kecepatan lebih penting saat harga jatuh).
 * 5. Saat terpicu: bunyi alert + toast, lalu performSell() → sellToken() → executeSwap di swap.ts
 *    TANPA konfirmasi ulang. Satu mint hanya boleh punya satu penjualan yang berjalan.
 * 6. Hasil: level ditandai selesai (persisten — reload tidak menjual dua kali). Jual 100% →
 *    aturan dimatikan. Gagal → cooldown bertahap; 3x gagal berturut-turut → aturan dimatikan.
 *
 * Batasan jujur:
 * - Hanya berjalan selama tab terbuka, komputer menyala, dan wallet tidak terkunci.
 * - Harga DexScreener bisa tertinggal beberapa detik. Saat dump cepat, eksekusi SL bisa
 *   terjadi di harga yang lebih buruk dari target (ditambah slippage).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getPriceSol, priceFeed, type PriceSnapshot } from "@/lib/price-feed";
import { playAlert } from "@/lib/sound";
import { performSell } from "@/lib/trade-actions";
import { formatPct, formatPrice } from "@/lib/format";
import { useAutoSellStore, type AutoSellRule, type TriggerKind } from "@/store/auto-sell-store";
import { useSettingsStore } from "@/store/settings-store";
import { pushToast } from "@/store/toast-store";
import type { TradeSource } from "@/store/trade-store";
import type { PositionRow } from "./usePositions";

// ===========================================================================
// Konstanta
// ===========================================================================

/** Data harga dianggap basi bila lebih lama dari ini → mesin tidak mengeksekusi. */
export const PRICE_STALE_MS = 12_000;
const CONFIRM_TICKS: Record<TriggerKind, number> = { "take-profit": 2, "stop-loss": 1, trailing: 1 };
const MAX_FAILURES = 3;
const BASE_COOLDOWN_MS = 4_000;
const LOCKED_WARNING_INTERVAL_MS = 30_000;

// ===========================================================================
// Evaluasi murni (tanpa efek samping) — mudah diuji
// ===========================================================================

export interface TriggerAction {
  kind: TriggerKind;
  levelId: string | null;
  sellPct: number;
  reason: string;
}

export interface RuleEvaluation {
  pnlPct: number;
  action: TriggerAction | null;
  trailingUpdate: { armed: boolean; peakPriceSol: number | null } | null;
  nextTakeProfit: { triggerPct: number; sellPct: number; priceSol: number } | null;
  stopLossPriceSol: number | null;
  trailingStopPriceSol: number | null;
  trailingArmed: boolean;
}

export function evaluateRule(rule: AutoSellRule, priceSol: number, entryPriceSol: number): RuleEvaluation {
  const pnlPct = (priceSol / entryPriceSol - 1) * 100;

  // --- Trailing: update status armed & harga puncak ---
  let trailingUpdate: RuleEvaluation["trailingUpdate"] = null;
  let trailingArmed = false;
  let peak: number | null = null;
  const trailing = rule.trailing;
  if (trailing && !trailing.done) {
    trailingArmed = trailing.armed || pnlPct >= trailing.activatePct;
    peak = trailingArmed ? Math.max(trailing.peakPriceSol ?? priceSol, priceSol) : trailing.peakPriceSol;
    if (trailingArmed !== trailing.armed || peak !== trailing.peakPriceSol) {
      trailingUpdate = { armed: trailingArmed, peakPriceSol: peak };
    }
  }
  const trailingStopPriceSol =
    trailing && !trailing.done && trailingArmed && peak !== null ? peak * (1 - trailing.distancePct / 100) : null;

  const stopLoss = rule.stopLoss && !rule.stopLoss.done ? rule.stopLoss : null;
  const stopLossPriceSol = stopLoss ? entryPriceSol * (1 - stopLoss.triggerPct / 100) : null;

  const pendingTakeProfits = rule.takeProfits
    .filter((level) => !level.done)
    .sort((a, b) => a.triggerPct - b.triggerPct);
  const nextLevel = pendingTakeProfits[0];
  const nextTakeProfit = nextLevel
    ? { triggerPct: nextLevel.triggerPct, sellPct: nextLevel.sellPct, priceSol: entryPriceSol * (1 + nextLevel.triggerPct / 100) }
    : null;

  // --- Prioritas: SL → Trailing → TP ---
  let action: TriggerAction | null = null;
  if (stopLoss && pnlPct <= -stopLoss.triggerPct) {
    action = {
      kind: "stop-loss",
      levelId: null,
      sellPct: stopLoss.sellPct,
      reason: `PnL ${formatPct(pnlPct)} ≤ −${stopLoss.triggerPct}%`,
    };
  } else if (trailing && trailingStopPriceSol !== null && peak !== null && priceSol <= trailingStopPriceSol) {
    action = {
      kind: "trailing",
      levelId: null,
      sellPct: trailing.sellPct,
      reason: `Harga turun ${trailing.distancePct}% dari puncak ${formatPrice(peak)} SOL`,
    };
  } else {
    // Bila harga melompati beberapa level sekaligus, level TERENDAH dijual dulu;
    // level berikutnya dievaluasi lagi di tick selanjutnya.
    const reached = pendingTakeProfits.find((level) => pnlPct >= level.triggerPct);
    if (reached) {
      action = {
        kind: "take-profit",
        levelId: reached.id,
        sellPct: reached.sellPct,
        reason: `PnL ${formatPct(pnlPct)} ≥ +${reached.triggerPct}%`,
      };
    }
  }

  return { pnlPct, action, trailingUpdate, nextTakeProfit, stopLossPriceSol, trailingStopPriceSol, trailingArmed };
}

// ===========================================================================
// Tipe hasil hook
// ===========================================================================

export type AutoSellStatus =
  | "active"
  | "disabled"
  | "engine-off"
  | "waiting-position"
  | "no-entry"
  | "no-price"
  | "stale"
  | "locked"
  | "cooldown"
  | "executing";

export interface AutoSellEvaluationView {
  mint: string;
  status: AutoSellStatus;
  pnlPct: number | null;
  priceSol: number | null;
  entryPriceSol: number | null;
  entrySource: "manual" | "journal" | null;
  nextTakeProfit: RuleEvaluation["nextTakeProfit"];
  stopLossPriceSol: number | null;
  trailingStopPriceSol: number | null;
  trailingArmed: boolean;
  pendingConfirmation: TriggerKind | null;
  updatedAt: number;
}

export interface UseAutoSellOptions {
  wallet: string | null;
  positions: PositionRow[];
  walletUnlocked: boolean;
}

export interface UseAutoSellResult {
  rules: AutoSellRule[];
  activeRuleCount: number;
  evaluations: Record<string, AutoSellEvaluationView>;
  executingMints: string[];
  engineEnabled: boolean;
  setEngineEnabled: (value: boolean) => void;
  isTabHidden: boolean;
  lastTickAt: number | null;
}

const SOURCE_BY_KIND: Record<TriggerKind, TradeSource> = {
  "take-profit": "auto-tp",
  "stop-loss": "auto-sl",
  trailing: "auto-trailing",
};

const LABEL_BY_KIND: Record<TriggerKind, string> = {
  "take-profit": "TAKE-PROFIT",
  "stop-loss": "STOP-LOSS",
  trailing: "TRAILING STOP",
};

// ===========================================================================
// Visibilitas tab
// ===========================================================================

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function getHiddenSnapshot(): boolean {
  return document.visibilityState === "hidden";
}

function getHiddenServerSnapshot(): boolean {
  return false;
}

function notifySystem(title: string, body: string): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (document.visibilityState !== "hidden" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: "smt-auto-sell" });
  } catch {
    // beberapa browser mobile hanya mengizinkan notifikasi lewat service worker
  }
}

// ===========================================================================
// Hook utama
// ===========================================================================

export function useAutoSell(options: UseAutoSellOptions): UseAutoSellResult {
  const allRules = useAutoSellStore((state) => state.rules);
  const engineEnabled = useSettingsStore((state) => state.autoSellEngineEnabled);
  const setEngineEnabled = useSettingsStore((state) => state.setAutoSellEngineEnabled);
  const isTabHidden = useSyncExternalStore(subscribeVisibility, getHiddenSnapshot, getHiddenServerSnapshot);

  const rules = options.wallet ? Object.values(allRules).filter((rule) => rule.wallet === options.wallet) : [];
  const activeMintsKey = rules
    .filter((rule) => rule.enabled)
    .map((rule) => rule.mint)
    .sort()
    .join(",");

  const [evaluations, setEvaluations] = useState<Record<string, AutoSellEvaluationView>>({});
  const [executingMints, setExecutingMints] = useState<string[]>([]);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);

  // Nilai terbaru untuk dibaca di dalam callback price feed (tanpa re-subscribe).
  const latestRef = useRef({
    wallet: options.wallet,
    positions: options.positions,
    walletUnlocked: options.walletUnlocked,
    rules,
    engineEnabled,
  });
  useEffect(() => {
    latestRef.current = {
      wallet: options.wallet,
      positions: options.positions,
      walletUnlocked: options.walletUnlocked,
      rules,
      engineEnabled,
    };
  });

  const confirmCountersRef = useRef(new Map<string, number>());
  const lastSeenFetchRef = useRef(new Map<string, number>());
  const inFlightRef = useRef(new Set<string>());
  const cooldownRef = useRef(new Map<string, number>());
  const lastLockedWarningRef = useRef(0);

  // Daftarkan mint yang punya aturan aktif ke price feed.
  useEffect(() => {
    if (!engineEnabled || !activeMintsKey) return undefined;
    return priceFeed.track(activeMintsKey.split(","));
  }, [engineEnabled, activeMintsKey]);

  // Inti mesin: dievaluasi setiap snapshot harga baru.
  useEffect(() => {
    const confirmCounters = confirmCountersRef.current;
    const lastSeenFetch = lastSeenFetchRef.current;
    const inFlight = inFlightRef.current;
    const cooldown = cooldownRef.current;

    const execute = (rule: AutoSellRule, action: TriggerAction, symbol: string | null) => {
      inFlight.add(rule.mint);
      setExecutingMints([...inFlight]);

      const label = LABEL_BY_KIND[action.kind];
      playAlert("trigger");
      pushToast({
        kind: action.kind === "stop-loss" ? "stop-loss" : "take-profit",
        title: `${label} terpicu · ${symbol ?? rule.mint.slice(0, 4)}`,
        message: `${action.reason}. Menjual ${action.sellPct}% posisi…`,
        durationMs: 5_000,
      });
      notifySystem(`${label} terpicu`, `${symbol ?? rule.mint}: ${action.reason}. Menjual ${action.sellPct}%.`);

      void performSell({
        mint: rule.mint,
        percent: action.sellPct,
        symbol,
        source: SOURCE_BY_KIND[action.kind],
        settingsOverride: { slippageBps: rule.slippageBps },
      })
        .then((outcome) => {
          const store = useAutoSellStore.getState();
          if (outcome.ok) {
            store.markTriggered(rule.key, action.kind, action.levelId, outcome.result.signature);
            if (action.sellPct >= 100) {
              store.setEnabled(rule.key, false);
            }
            cooldown.delete(rule.key);
            notifySystem(`${label} tereksekusi`, `${symbol ?? rule.mint}: terjual ${action.sellPct}%.`);
            return;
          }

          const code = outcome.error.code;
          if (code === "WALLET_LOCKED") return;
          if (code === "NO_TOKEN_BALANCE") {
            store.setEnabled(rule.key, false);
            pushToast({
              kind: "warning",
              title: "Auto-sell dimatikan",
              message: `${symbol ?? rule.mint}: tidak ada saldo token untuk dijual.`,
            });
            return;
          }

          const failures = store.recordFailure(rule.key);
          cooldown.set(rule.key, Date.now() + BASE_COOLDOWN_MS * failures);
          if (failures >= MAX_FAILURES) {
            store.setEnabled(rule.key, false);
            pushToast({
              kind: "error",
              title: "Auto-sell dimatikan setelah 3x gagal",
              message: `${symbol ?? rule.mint}: ${outcome.error.message}. Periksa slippage / saldo SOL untuk fee, lalu aktifkan lagi.`,
              durationMs: 15_000,
            });
          }
        })
        .finally(() => {
          inFlight.delete(rule.mint);
          setExecutingMints([...inFlight]);
          for (const key of [...confirmCounters.keys()]) {
            if (key.startsWith(`${rule.key}|`)) confirmCounters.delete(key);
          }
        });
    };

    const evaluate = (snapshot: PriceSnapshot) => {
      const { wallet, positions, walletUnlocked, rules: currentRules, engineEnabled: enabled } = latestRef.current;
      if (!wallet) return;
      const now = Date.now();
      const positionsByMint = new Map(positions.map((position) => [position.mint, position]));
      const views: Record<string, AutoSellEvaluationView> = {};

      for (const rule of currentRules) {
        const position = positionsByMint.get(rule.mint);
        const market = snapshot.prices[rule.mint];
        const priceSol = getPriceSol(market, snapshot.solUsd);
        const entryPriceSol =
          rule.manualEntryPriceSol !== null && rule.manualEntryPriceSol > 0
            ? rule.manualEntryPriceSol
            : position?.avgPriceSol ?? null;
        const entrySource: AutoSellEvaluationView["entrySource"] =
          rule.manualEntryPriceSol !== null && rule.manualEntryPriceSol > 0
            ? "manual"
            : position?.avgPriceSol
              ? "journal"
              : null;

        const baseView: AutoSellEvaluationView = {
          mint: rule.mint,
          status: "active",
          pnlPct: null,
          priceSol,
          entryPriceSol,
          entrySource,
          nextTakeProfit: null,
          stopLossPriceSol: null,
          trailingStopPriceSol: null,
          trailingArmed: false,
          pendingConfirmation: null,
          updatedAt: now,
        };

        if (!rule.enabled) {
          views[rule.mint] = { ...baseView, status: "disabled" };
          continue;
        }
        if (!enabled) {
          views[rule.mint] = { ...baseView, status: "engine-off" };
          continue;
        }
        if (!position || position.balanceRaw <= 0n) {
          views[rule.mint] = { ...baseView, status: "waiting-position" };
          continue;
        }
        if (entryPriceSol === null) {
          views[rule.mint] = { ...baseView, status: "no-entry" };
          continue;
        }
        if (!market || priceSol === null) {
          views[rule.mint] = { ...baseView, status: "no-price" };
          continue;
        }

        const evaluation = evaluateRule(rule, priceSol, entryPriceSol);
        if (evaluation.trailingUpdate) {
          useAutoSellStore.getState().updateTrailing(rule.key, evaluation.trailingUpdate);
        }

        const view: AutoSellEvaluationView = {
          ...baseView,
          pnlPct: evaluation.pnlPct,
          nextTakeProfit: evaluation.nextTakeProfit,
          stopLossPriceSol: evaluation.stopLossPriceSol,
          trailingStopPriceSol: evaluation.trailingStopPriceSol,
          trailingArmed: evaluation.trailingArmed,
        };

        if (now - market.fetchedAt > PRICE_STALE_MS) {
          views[rule.mint] = { ...view, status: "stale" };
          continue;
        }
        if (inFlight.has(rule.mint)) {
          views[rule.mint] = { ...view, status: "executing" };
          continue;
        }

        // Hitung konfirmasi hanya bila data harga mint ini benar-benar baru.
        const isFreshData = lastSeenFetch.get(rule.mint) !== market.fetchedAt;
        lastSeenFetch.set(rule.mint, market.fetchedAt);

        const action = evaluation.action;
        if (!action) {
          for (const key of [...confirmCounters.keys()]) {
            if (key.startsWith(`${rule.key}|`)) confirmCounters.delete(key);
          }
          views[rule.mint] = view;
          continue;
        }

        const counterKey = `${rule.key}|${action.kind}|${action.levelId ?? ""}`;
        const count = (confirmCounters.get(counterKey) ?? 0) + (isFreshData ? 1 : 0);
        confirmCounters.set(counterKey, count);

        if (count < CONFIRM_TICKS[action.kind]) {
          views[rule.mint] = { ...view, pendingConfirmation: action.kind };
          continue;
        }
        if ((cooldown.get(rule.key) ?? 0) > now) {
          views[rule.mint] = { ...view, status: "cooldown" };
          continue;
        }
        if (!walletUnlocked) {
          views[rule.mint] = { ...view, status: "locked" };
          if (now - lastLockedWarningRef.current > LOCKED_WARNING_INTERVAL_MS) {
            lastLockedWarningRef.current = now;
            playAlert("error");
            pushToast({
              kind: "error",
              title: `${LABEL_BY_KIND[action.kind]} terpicu tapi wallet TERKUNCI`,
              message: `${position.symbol}: buka kunci wallet agar auto-sell bisa menjual.`,
              durationMs: 12_000,
            });
          }
          continue;
        }

        views[rule.mint] = { ...view, status: "executing" };
        execute(rule, action, position.symbol);
      }

      setEvaluations(views);
      setLastTickAt(now);
    };

    let lastTick = -1;
    return priceFeed.subscribe(() => {
      const snapshot = priceFeed.getSnapshot();
      if (snapshot.tick === lastTick) return;
      lastTick = snapshot.tick;
      evaluate(snapshot);
    });
  }, []);

  // Cegah layar mati (sleep) saat mesin aktif dan tab terlihat.
  const hasActiveRules = engineEnabled && activeMintsKey.length > 0;
  useEffect(() => {
    if (!hasActiveRules || isTabHidden || typeof navigator === "undefined" || !("wakeLock" in navigator)) {
      return undefined;
    }
    let sentinel: WakeLockSentinel | null = null;
    let released = false;
    navigator.wakeLock
      .request("screen")
      .then((lock) => {
        if (released) void lock.release().catch(() => undefined);
        else sentinel = lock;
      })
      .catch(() => undefined);
    return () => {
      released = true;
      if (sentinel) void sentinel.release().catch(() => undefined);
    };
  }, [hasActiveRules, isTabHidden]);

  return {
    rules,
    activeRuleCount: rules.filter((rule) => rule.enabled).length,
    evaluations,
    executingMints,
    engineEnabled,
    setEngineEnabled,
    isTabHidden,
    lastTickAt,
  };
}
