"use client";

import { useEffect, useState } from "react";
import { watchTokenBalance, type TokenBalance } from "@/lib/wallet";
import { useJournalStore } from "@/store/journal-store";

/** Saldo token live (WebSocket ATA + polling) untuk panel Sell. */
export function useTokenBalance(owner: string | null, mint: string | null): TokenBalance | null {
  const holdingsNonce = useJournalStore((state) => state.holdingsNonce);
  const [state, setState] = useState<{ key: string; balance: TokenBalance } | null>(null);

  useEffect(() => {
    if (!owner || !mint) return undefined;
    const key = `${owner}:${mint}`;
    return watchTokenBalance(owner, mint, (balance) => setState({ key, balance }), { pollIntervalMs: 10_000 });
  }, [owner, mint, holdingsNonce]);

  const key = owner && mint ? `${owner}:${mint}` : null;
  return state && state.key === key ? state.balance : null;
}
