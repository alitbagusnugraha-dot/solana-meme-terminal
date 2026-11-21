"use client";

import { useEffect, useState } from "react";
import { scanToken, type TokenScanResult } from "@/lib/scanner";
import { toError } from "@/lib/rpc";

interface ScanState {
  key: string;
  mint: string;
  result: TokenScanResult | null;
  error: string | null;
}

export interface TokenScanView {
  loading: boolean;
  result: TokenScanResult | null;
  error: string | null;
  rescan: () => void;
}

/** Scan keamanan on-chain + DexScreener untuk CA terpilih. */
export function useTokenScan(mint: string | null): TokenScanView {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<ScanState | null>(null);

  useEffect(() => {
    if (!mint) return undefined;
    let cancelled = false;
    const key = `${mint}:${nonce}`;
    scanToken(mint).then(
      (result) => {
        if (!cancelled) setState({ key, mint, result, error: null });
      },
      (error: unknown) => {
        if (!cancelled) setState({ key, mint, result: null, error: toError(error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mint, nonce]);

  const currentKey = mint ? `${mint}:${nonce}` : null;
  const currentState = state && state.key === currentKey ? state : null;
  // Saat scan ulang, tampilkan hasil lama untuk mint yang sama sampai hasil baru datang.
  const sameMintState = state && state.mint === mint ? state : null;

  return {
    loading: Boolean(mint) && !currentState,
    result: sameMintState?.result ?? null,
    error: currentState?.error ?? null,
    rescan: () => setNonce((value) => value + 1),
  };
}
