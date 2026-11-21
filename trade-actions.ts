/**
 * src/lib/trade-actions.ts — Satu jalur eksekusi untuk SEMUA transaksi:
 * tombol Buy/Sell manual, Panic Sell, dan mesin Auto TP/SL.
 *
 * Tugas: panggil buyToken/sellToken (swap.ts), catat hasil AKTUAL ke jurnal,
 * update status UI, tampilkan toast, bunyikan alert, dan refresh saldo.
 */

import { SOL_DECIMALS, rawToUiAmount, toError } from "./rpc";
import { playAlert, type AlertKind } from "./sound";
import { SwapError, buyToken, sellToken, type SwapResult, type SwapSettings } from "./swap";
import { getUnlockedPublicKey } from "./wallet";
import { priceFeed } from "./price-feed";
import { formatSol, formatTokenAmount } from "./format";
import { useJournalStore } from "@/store/journal-store";
import { useSettingsStore } from "@/store/settings-store";
import { pushToast, type ToastKind } from "@/store/toast-store";
import { useTradeStore, type TradeSource } from "@/store/trade-store";

export type TradeOutcome = { ok: true; result: SwapResult } | { ok: false; error: SwapError };

const SOURCE_LABEL: Record<TradeSource, string> = {
  manual: "Manual",
  panic: "PANIC SELL",
  "auto-tp": "Auto Take-Profit",
  "auto-sl": "Auto Stop-Loss",
  "auto-trailing": "Auto Trailing Stop",
};

function alertFor(source: TradeSource, ok: boolean): AlertKind {
  if (!ok) return "error";
  if (source === "auto-tp") return "take-profit";
  if (source === "auto-sl") return "stop-loss";
  if (source === "auto-trailing") return "trailing";
  return "success";
}

function toastKindFor(source: TradeSource): ToastKind {
  if (source === "auto-tp" || source === "auto-trailing") return "take-profit";
  if (source === "auto-sl") return "stop-loss";
  return "success";
}

function asSwapError(error: unknown): SwapError {
  return error instanceof SwapError ? error : new SwapError("TX_FAILED", toError(error).message);
}

function tradeId(mint: string, side: string): string {
  return `${side}:${mint}:${Date.now()}`;
}

function describeResult(result: SwapResult, symbol: string | null): string {
  const label = symbol ?? "token";
  const executed = result.executed;
  if (executed) {
    const sol = rawToUiAmount(executed.swapSolLamports < 0n ? -executed.swapSolLamports : executed.swapSolLamports, SOL_DECIMALS);
    const tokens = Math.abs(executed.tokenDeltaUi);
    return result.side === "buy"
      ? `${formatSol(sol)} SOL → ${formatTokenAmount(tokens)} ${label}`
      : `${formatTokenAmount(tokens)} ${label} → ${formatSol(sol)} SOL`;
  }
  return `Confirmed dalam ${(result.timings.totalMs / 1000).toFixed(1)} dtk (detail jumlah menyusul)`;
}

async function runTrade(params: {
  side: "buy" | "sell";
  mint: string;
  symbol: string | null;
  source: TradeSource;
  execute: (onStatus: Parameters<typeof buyToken>[0]["onStatus"]) => Promise<SwapResult>;
  silentToast?: boolean;
}): Promise<TradeOutcome> {
  const wallet = getUnlockedPublicKey()?.toBase58() ?? null;
  const id = tradeId(params.mint, params.side);
  const tradeStore = useTradeStore.getState();
  const startedAt = Date.now();

  tradeStore.start({
    id,
    mint: params.mint,
    symbol: params.symbol,
    side: params.side,
    source: params.source,
    stage: "preparing",
    message: "Menyiapkan…",
    startedAt,
    signature: null,
  });

  try {
    const result = await params.execute((update) => {
      useTradeStore.getState().update(id, {
        stage: update.stage,
        message: update.message,
        ...(update.signature ? { signature: update.signature } : {}),
      });
    });

    if (wallet) {
      useJournalStore.getState().recordSwap(result, { wallet, symbol: params.symbol, source: params.source });
    }
    useJournalStore.getState().bumpHoldings();
    priceFeed.refreshSoon();

    const summary = describeResult(result, params.symbol);
    useTradeStore.getState().finish(id, {
      id,
      mint: params.mint,
      symbol: params.symbol,
      side: params.side,
      source: params.source,
      ok: true,
      message: summary,
      signature: result.signature,
      explorerUrl: result.explorerUrl,
      totalMs: result.timings.totalMs,
      finishedAt: Date.now(),
    });

    playAlert(alertFor(params.source, true));
    if (!params.silentToast) {
      pushToast({
        kind: params.side === "buy" ? "success" : toastKindFor(params.source),
        title: `${SOURCE_LABEL[params.source]} · ${params.side === "buy" ? "BELI" : "JUAL"} berhasil`,
        message: `${summary}${result.warnings.length ? ` · ${result.warnings[0]}` : ""}`,
        href: result.explorerUrl,
        hrefLabel: "Solscan",
      });
    }
    return { ok: true, result };
  } catch (error) {
    const swapError = asSwapError(error);
    useTradeStore.getState().finish(id, {
      id,
      mint: params.mint,
      symbol: params.symbol,
      side: params.side,
      source: params.source,
      ok: false,
      message: swapError.message,
      signature: swapError.signature,
      explorerUrl: swapError.signature ? `https://solscan.io/tx/${swapError.signature}` : null,
      totalMs: Date.now() - startedAt,
      finishedAt: Date.now(),
    });
    playAlert("error");
    pushToast({
      kind: "error",
      title: `${SOURCE_LABEL[params.source]} · ${params.side === "buy" ? "BELI" : "JUAL"} gagal`,
      message: swapError.message,
      href: swapError.signature ? `https://solscan.io/tx/${swapError.signature}` : undefined,
      hrefLabel: swapError.signature ? "Lihat transaksi" : undefined,
    });
    // Saldo bisa saja berubah (mis. tx gagal tapi fee terbayar) → refresh.
    useJournalStore.getState().bumpHoldings();
    return { ok: false, error: swapError };
  }
}

export function performBuy(params: { mint: string; solAmount: number | string; symbol: string | null }): Promise<TradeOutcome> {
  const settings = useSettingsStore.getState().swap;
  return runTrade({
    side: "buy",
    mint: params.mint,
    symbol: params.symbol,
    source: "manual",
    execute: (onStatus) => buyToken({ mint: params.mint, solAmount: params.solAmount, settings, onStatus }),
  });
}

export function performSell(params: {
  mint: string;
  percent: number;
  symbol: string | null;
  source: TradeSource;
  settingsOverride?: Partial<SwapSettings>;
}): Promise<TradeOutcome> {
  const state = useSettingsStore.getState();
  const settings: Partial<SwapSettings> = { ...state.swap, ...params.settingsOverride };

  if (params.source === "panic") {
    const current = typeof settings.slippageBps === "number" ? settings.slippageBps : 0;
    settings.slippageBps = Math.max(current, state.panicSlippageBps);
  }

  return runTrade({
    side: "sell",
    mint: params.mint,
    symbol: params.symbol,
    source: params.source,
    execute: (onStatus) => sellToken({ mint: params.mint, percent: params.percent, settings, onStatus }),
  });
}
