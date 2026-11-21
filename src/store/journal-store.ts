/**
 * Jurnal transaksi per wallet — dasar harga beli rata-rata & PnL.
 *
 * Metode: average cost.
 * - BUY  : qty += token diterima; cost += SOL keluar (swap + network fee + tip).
 *          Rent ATA TIDAK dihitung sebagai biaya karena bisa ditarik kembali.
 * - SELL : biaya keluar = cost × (token dijual / qty); realized += hasil bersih − biaya keluar.
 * Angka diambil dari meta transaksi on-chain (SwapResult.executed). Bila RPC belum
 * mengembalikan detail, dipakai angka quote dan record ditandai `estimated`.
 *
 * BigInt disimpan sebagai string karena JSON tidak mendukung BigInt.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SwapResult } from "@/lib/swap";
import type { TradeSource } from "./trade-store";

export interface TradeRecord {
  id: string;
  wallet: string;
  mint: string;
  symbol: string | null;
  side: "buy" | "sell";
  /** Jumlah token (absolut, satuan mentah). */
  tokenRaw: string;
  /** BUY: total SOL dibayar (lamports). SELL: SOL bersih diterima (lamports). */
  solLamports: string;
  decimals: number;
  source: TradeSource;
  estimated: boolean;
  signature: string;
  timestamp: number;
}

export interface LedgerEntry {
  mint: string;
  symbol: string | null;
  decimals: number;
  qtyRaw: bigint;
  costLamports: bigint;
  realizedLamports: bigint;
  boughtLamports: bigint;
  soldLamports: bigint;
  buyCount: number;
  sellCount: number;
  hasEstimated: boolean;
  lastTradeAt: number;
}

const MAX_RECORDS = 2_000;
const BASE_FEE_LAMPORTS = 5_000n;

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

export function tradeRecordFromSwap(
  result: SwapResult,
  context: { wallet: string; symbol: string | null; source: TradeSource },
): TradeRecord {
  let tokenRaw: bigint;
  let solLamports: bigint;
  let estimated = false;

  if (result.executed) {
    const { executed } = result;
    tokenRaw = abs(executed.tokenDeltaRaw);
    const fees = executed.networkFeeLamports + executed.tipLamports;
    solLamports =
      result.side === "buy"
        ? nonNegative(-executed.swapSolLamports + fees)
        : nonNegative(executed.swapSolLamports - fees);
  } else {
    estimated = true;
    const fees = result.fees.priorityFeeLamports + result.fees.tipLamports + BASE_FEE_LAMPORTS;
    if (result.side === "buy") {
      tokenRaw = result.quote.outAmountRaw;
      solLamports = result.quote.inAmountRaw + fees;
    } else {
      tokenRaw = result.quote.inAmountRaw;
      solLamports = nonNegative(result.quote.outAmountRaw - fees);
    }
  }

  return {
    id: result.signature,
    wallet: context.wallet,
    mint: result.mint,
    symbol: context.symbol,
    side: result.side,
    tokenRaw: tokenRaw.toString(),
    solLamports: solLamports.toString(),
    decimals: result.tokenDecimals,
    source: context.source,
    estimated,
    signature: result.signature,
    timestamp: result.executed?.blockTime ? result.executed.blockTime * 1000 : Date.now(),
  };
}

/** Hitung posisi per mint (average cost). Fungsi murni — aman dipanggil saat render. */
export function buildLedger(trades: readonly TradeRecord[], wallet: string | null): Map<string, LedgerEntry> {
  const ledger = new Map<string, LedgerEntry>();
  if (!wallet) return ledger;

  const ordered = trades.filter((trade) => trade.wallet === wallet).sort((a, b) => a.timestamp - b.timestamp);

  for (const trade of ordered) {
    const tokens = BigInt(trade.tokenRaw);
    const sol = BigInt(trade.solLamports);
    const entry: LedgerEntry = ledger.get(trade.mint) ?? {
      mint: trade.mint,
      symbol: trade.symbol,
      decimals: trade.decimals,
      qtyRaw: 0n,
      costLamports: 0n,
      realizedLamports: 0n,
      boughtLamports: 0n,
      soldLamports: 0n,
      buyCount: 0,
      sellCount: 0,
      hasEstimated: false,
      lastTradeAt: 0,
    };

    if (trade.symbol) entry.symbol = trade.symbol;
    entry.decimals = trade.decimals;
    entry.hasEstimated = entry.hasEstimated || trade.estimated;
    entry.lastTradeAt = Math.max(entry.lastTradeAt, trade.timestamp);

    if (trade.side === "buy") {
      entry.qtyRaw += tokens;
      entry.costLamports += sol;
      entry.boughtLamports += sol;
      entry.buyCount += 1;
    } else {
      const sold = tokens > entry.qtyRaw ? entry.qtyRaw : tokens;
      const costOut = entry.qtyRaw > 0n ? (entry.costLamports * sold) / entry.qtyRaw : 0n;
      entry.realizedLamports += sol - costOut;
      entry.costLamports -= costOut;
      entry.qtyRaw -= sold;
      entry.soldLamports += sol;
      entry.sellCount += 1;
      if (entry.qtyRaw === 0n) entry.costLamports = 0n;
    }
    ledger.set(trade.mint, entry);
  }
  return ledger;
}

/** Harga beli rata-rata dalam SOL per 1 token (satuan tampilan). */
export function averageEntryPriceSol(entry: LedgerEntry | undefined): number | null {
  if (!entry || entry.qtyRaw <= 0n || entry.costLamports <= 0n) return null;
  const tokens = Number(entry.qtyRaw) / 10 ** entry.decimals;
  const sol = Number(entry.costLamports) / 1e9;
  return tokens > 0 ? sol / tokens : null;
}

interface JournalState {
  trades: TradeRecord[];
  /** Dinaikkan setelah setiap transaksi agar saldo/posisi segera di-refresh. */
  holdingsNonce: number;
  recordSwap: (result: SwapResult, context: { wallet: string; symbol: string | null; source: TradeSource }) => void;
  removeMint: (wallet: string, mint: string) => void;
  clearWallet: (wallet: string) => void;
  bumpHoldings: () => void;
}

export const useJournalStore = create<JournalState>()(
  persist(
    (set) => ({
      trades: [],
      holdingsNonce: 0,
      recordSwap: (result, context) =>
        set((state) => {
          if (state.trades.some((trade) => trade.id === result.signature)) return state;
          const record = tradeRecordFromSwap(result, context);
          return { trades: [...state.trades, record].slice(-MAX_RECORDS) };
        }),
      removeMint: (wallet, mint) =>
        set((state) => ({ trades: state.trades.filter((trade) => !(trade.wallet === wallet && trade.mint === mint)) })),
      clearWallet: (wallet) => set((state) => ({ trades: state.trades.filter((trade) => trade.wallet !== wallet) })),
      bumpHoldings: () => set((state) => ({ holdingsNonce: state.holdingsNonce + 1 })),
    }),
    {
      name: "smt:journal:v1",
      version: 1,
      storage: createJSONStorage(() => window.localStorage),
      partialize: (state) => ({ trades: state.trades }),
    },
  ),
);
