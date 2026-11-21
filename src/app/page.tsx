"use client";

/**
 * src/app/page.tsx — Halaman utama terminal.
 *
 * Seluruh terminal dirender hanya di browser (wallet, localStorage, WebSocket,
 * Web Audio tidak ada di server). Saat SSR, yang dikirim hanya layar "memuat".
 *
 * Aliran state:
 *  - wallet-store     : status lock/unlock + saldo SOL live (useWalletBootstrap)
 *  - settings-store   : slippage, priority fee, tip, mode kirim (persist)
 *  - price-feed       : SATU polling DexScreener 2 dtk untuk semua mint
 *  - usePositions     : saldo on-chain + jurnal (avg beli) + harga live → PnL
 *  - useAutoSell      : mesin TP/SL/trailing → performSell → executeSwap (swap.ts)
 *  - trade-store      : status transaksi berjalan (progress bar di panel trade)
 */

import { useState, useSyncExternalStore } from "react";
import { performSell } from "@/lib/trade-actions";
import { getPriceSol } from "@/lib/price-feed";
import { useWalletBootstrap } from "@/hooks/useWalletBootstrap";
import { useRpcHealth } from "@/hooks/useRpcHealth";
import { useTokenScan } from "@/hooks/useTokenScan";
import { usePositions, type PositionRow } from "@/hooks/usePositions";
import { useAutoSell } from "@/hooks/useAutoSell";
import { usePriceFeed } from "@/hooks/usePriceFeed";
import { useWalletStore } from "@/store/wallet-store";
import { useSettingsStore } from "@/store/settings-store";
import { useTradeStore } from "@/store/trade-store";
import { ruleKey, useAutoSellStore } from "@/store/auto-sell-store";
import { Header } from "@/components/Header";
import { ScannerPanel } from "@/components/ScannerPanel";
import { TradePanel } from "@/components/TradePanel";
import { PositionsTable } from "@/components/PositionsTable";
import { WalletDialogs } from "@/components/WalletDialogs";
import { Toaster } from "@/components/Toaster";
import { Spinner } from "@/components/ui";

function subscribeNothing(): () => void {
  return () => undefined;
}

function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

function BootScreen() {
  return (
    <div className="grid min-h-dvh place-items-center bg-bg text-muted">
      <div className="flex items-center gap-2 text-sm">
        <Spinner /> Memuat terminal…
      </div>
    </div>
  );
}

function Terminal() {
  const publicKey = useWalletStore((state) => state.publicKey);
  const walletStatus = useWalletStore((state) => state.status);
  const lastMint = useSettingsStore((state) => state.lastMint);
  const setLastMint = useSettingsStore((state) => state.setLastMint);
  const activeTrades = useTradeStore((state) => state.active);
  const allRules = useAutoSellStore((state) => state.rules);

  const [mint, setMint] = useState<string | null>(lastMint);
  const walletUnlocked = walletStatus === "unlocked";

  const rpcHealth = useRpcHealth();
  const scan = useTokenScan(mint);
  const positions = usePositions(publicKey);
  const autoSell = useAutoSell({ wallet: publicKey, positions: positions.rows, walletUnlocked });
  const feed = usePriceFeed([mint]);

  useWalletBootstrap({ hasActiveAutoSell: autoSell.engineEnabled && autoSell.activeRuleCount > 0 });

  const selectMint = (value: string) => {
    setMint(value);
    setLastMint(value);
  };

  const liveMarket = mint ? (feed.prices[mint] ?? scan.result?.market ?? null) : null;
  const selectedPosition = mint ? (positions.rows.find((row) => row.mint === mint) ?? null) : null;
  const selectedRule = publicKey && mint ? (allRules[ruleKey(publicKey, mint)] ?? null) : null;
  const solUsd = feed.solUsd ?? positions.solUsd;

  const sellingMints = new Set([
    ...autoSell.executingMints,
    ...Object.values(activeTrades)
      .filter((trade) => trade.side === "sell")
      .map((trade) => trade.mint),
  ]);

  const panicSell = (row: PositionRow) => {
    void performSell({ mint: row.mint, percent: 100, symbol: row.symbol, source: "panic" });
  };

  return (
    <div className="min-h-dvh bg-bg">
      <Header rpcHealth={rpcHealth} solUsd={solUsd} activeAutoSell={autoSell.engineEnabled ? autoSell.activeRuleCount : 0} />

      {autoSell.activeRuleCount > 0 && autoSell.engineEnabled && !walletUnlocked && walletStatus !== "none" ? (
        <div className="border-b border-down/40 bg-down/10 px-3 py-1.5 text-center text-xs text-down">
          Ada {autoSell.activeRuleCount} aturan Auto TP/SL aktif, tapi wallet TERKUNCI — mesin tidak bisa menjual. Buka kunci wallet.
        </div>
      ) : null}

      <main className="mx-auto flex max-w-[1800px] flex-col gap-3 p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
          <ScannerPanel key={mint ?? "empty"} mint={mint} onSelectMint={selectMint} scan={scan} market={liveMarket} />
          <TradePanel
            mint={mint}
            market={liveMarket}
            position={selectedPosition}
            priceSol={getPriceSol(liveMarket, solUsd)}
            autoSell={{
              rule: selectedRule,
              evaluation: mint ? autoSell.evaluations[mint] : undefined,
              engineEnabled: autoSell.engineEnabled,
              setEngineEnabled: autoSell.setEngineEnabled,
            }}
          />
        </div>

        <PositionsTable
          view={positions}
          evaluations={autoSell.evaluations}
          executingMints={[...sellingMints]}
          selectedMint={mint}
          walletUnlocked={walletUnlocked}
          onSelect={selectMint}
          onPanicSell={panicSell}
        />

        <footer className="pb-6 pt-1 text-center text-[10px] text-dim">
          Burner wallet disimpan terenkripsi di browser ini. Auto TP/SL hanya berjalan selama tab terbuka.
          {autoSell.isTabHidden ? " · Tab sedang di background (heartbeat worker tetap berjalan)." : ""}
        </footer>
      </main>

      <WalletDialogs />
      <Toaster />
    </div>
  );
}

export default function Page() {
  const isClient = useIsClient();
  return isClient ? <Terminal /> : <BootScreen />;
}
