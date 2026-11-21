"use client";

import { useEffect, useState } from "react";
import { getAllTokenHoldings, type TokenHolding } from "@/lib/wallet";
import { subscribeHeartbeat } from "@/lib/heartbeat";
import { getPriceSol } from "@/lib/price-feed";
import { toError } from "@/lib/rpc";
import type { MarketData } from "@/lib/scanner";
import { averageEntryPriceSol, buildLedger, useJournalStore, type LedgerEntry } from "@/store/journal-store";
import { usePriceFeed } from "./usePriceFeed";

const HOLDINGS_REFRESH_MS = 10_000;

export interface PositionRow {
  mint: string;
  symbol: string;
  name: string | null;
  imageUrl: string | null;
  programId: string;
  decimals: number;
  /** Saldo on-chain (sumber kebenaran). */
  balanceRaw: bigint;
  balanceUi: number;
  /** Harga beli rata-rata (SOL per token, termasuk fee & tip). Null = bukan dibeli lewat terminal. */
  avgPriceSol: number | null;
  priceSol: number | null;
  priceUsd: number | null;
  valueSol: number | null;
  valueUsd: number | null;
  /** Modal tersisa untuk qty yang masih dipegang (SOL). */
  costSol: number | null;
  unrealizedSol: number | null;
  pnlPct: number | null;
  realizedSol: number;
  hasCostBasis: boolean;
  estimatedCost: boolean;
  priceChange5m: number | null;
  priceChange1h: number | null;
  market: MarketData | null;
  priceUpdatedAt: number | null;
}

export interface PositionsTotals {
  valueSol: number;
  valueUsd: number | null;
  unrealizedSol: number;
  realizedSol: number;
  costSol: number;
}

export interface PositionsView {
  rows: PositionRow[];
  totals: PositionsTotals;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
  solUsd: number | null;
}

function buildRow(
  holding: TokenHolding,
  ledgerEntry: LedgerEntry | undefined,
  market: MarketData | undefined,
  solUsd: number | null,
): PositionRow {
  const priceSol = getPriceSol(market, solUsd);
  const avgPriceSol = averageEntryPriceSol(ledgerEntry);
  const valueSol = priceSol !== null ? priceSol * holding.uiAmount : null;
  const costSol = avgPriceSol !== null ? avgPriceSol * holding.uiAmount : null;
  const unrealizedSol = valueSol !== null && costSol !== null ? valueSol - costSol : null;
  const pnlPct = priceSol !== null && avgPriceSol !== null && avgPriceSol > 0 ? (priceSol / avgPriceSol - 1) * 100 : null;

  return {
    mint: holding.mint,
    symbol: market?.symbol ?? ledgerEntry?.symbol ?? `${holding.mint.slice(0, 4)}…`,
    name: market?.name ?? null,
    imageUrl: market?.imageUrl ?? null,
    programId: holding.programId,
    decimals: holding.decimals,
    balanceRaw: holding.totalRaw,
    balanceUi: holding.uiAmount,
    avgPriceSol,
    priceSol,
    priceUsd: market?.priceUsd ?? null,
    valueSol,
    valueUsd:
      valueSol !== null && solUsd !== null
        ? valueSol * solUsd
        : market?.priceUsd !== null && market?.priceUsd !== undefined
          ? market.priceUsd * holding.uiAmount
          : null,
    costSol,
    unrealizedSol,
    pnlPct,
    realizedSol: ledgerEntry ? Number(ledgerEntry.realizedLamports) / 1e9 : 0,
    hasCostBasis: avgPriceSol !== null,
    estimatedCost: ledgerEntry?.hasEstimated ?? false,
    priceChange5m: market?.priceChangePct.m5 ?? null,
    priceChange1h: market?.priceChangePct.h1 ?? null,
    market: market ?? null,
    priceUpdatedAt: market?.fetchedAt ?? null,
  };
}

/**
 * Posisi aktif = saldo on-chain (getAllTokenHoldings tiap 10 dtk & setelah transaksi)
 * + harga beli rata-rata dari jurnal + harga live dari price feed.
 */
export function usePositions(owner: string | null): PositionsView {
  const holdingsNonce = useJournalStore((state) => state.holdingsNonce);
  const trades = useJournalStore((state) => state.trades);
  const [data, setData] = useState<{ owner: string; holdings: TokenHolding[]; at: number } | null>(null);
  const [error, setError] = useState<{ owner: string; message: string } | null>(null);

  useEffect(() => {
    if (!owner) return undefined;
    let active = true;
    let running = false;
    let lastLoad = 0;

    const load = async () => {
      running = true;
      try {
        const holdings = await getAllTokenHoldings(owner);
        if (active) {
          setData({ owner, holdings, at: Date.now() });
          setError(null);
        }
      } catch (loadError) {
        if (active) setError({ owner, message: toError(loadError).message });
      } finally {
        running = false;
      }
    };

    const unsubscribe = subscribeHeartbeat((now) => {
      if (running || now - lastLoad < HOLDINGS_REFRESH_MS) return;
      lastLoad = now;
      void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [owner, holdingsNonce]);

  const holdings = data && data.owner === owner ? data.holdings : [];
  const ledger = buildLedger(trades, owner);
  const snapshot = usePriceFeed(holdings.map((holding) => holding.mint));

  const rows = holdings
    .map((holding) => buildRow(holding, ledger.get(holding.mint), snapshot.prices[holding.mint], snapshot.solUsd))
    .sort((a, b) => (b.valueSol ?? -1) - (a.valueSol ?? -1));

  let realizedSol = 0;
  for (const entry of ledger.values()) realizedSol += Number(entry.realizedLamports) / 1e9;

  const totals: PositionsTotals = {
    valueSol: rows.reduce((sum, row) => sum + (row.valueSol ?? 0), 0),
    valueUsd: snapshot.solUsd !== null ? rows.reduce((sum, row) => sum + (row.valueSol ?? 0), 0) * snapshot.solUsd : null,
    unrealizedSol: rows.reduce((sum, row) => sum + (row.unrealizedSol ?? 0), 0),
    realizedSol,
    costSol: rows.reduce((sum, row) => sum + (row.costSol ?? 0), 0),
  };

  return {
    rows,
    totals,
    loading: Boolean(owner) && (!data || data.owner !== owner),
    error: error && error.owner === owner ? error.message : null,
    updatedAt: data && data.owner === owner ? data.at : null,
    solUsd: snapshot.solUsd,
  };
}
