"use client";

import { useState } from "react";
import { performBuy, performSell } from "@/lib/trade-actions";
import { formatPct, formatPrice, formatSol, formatTokenAmount, timeAgo } from "@/lib/format";
import type { SendMode, SwapStage } from "@/lib/swap";
import type { MarketData } from "@/lib/scanner";
import type { PositionRow } from "@/hooks/usePositions";
import type { AutoSellEvaluationView } from "@/hooks/useAutoSell";
import { useTokenBalance } from "@/hooks/useTokenBalance";
import { useNow } from "@/hooks/useNow";
import { useSettingsStore } from "@/store/settings-store";
import { useTradeStore } from "@/store/trade-store";
import { useWalletStore } from "@/store/wallet-store";
import { useUiStore } from "@/store/ui-store";
import type { AutoSellRule } from "@/store/auto-sell-store";
import { AutoSellForm } from "./AutoSellForm";
import { Badge, Button, Field, Input, Panel, Spinner, Toggle, cn } from "./ui";

const STAGES: SwapStage[] = ["building", "simulating", "signing", "sending", "confirming", "confirmed"];
const STAGE_LABEL: Record<SwapStage, string> = {
  preparing: "Siapkan",
  building: "Rute",
  simulating: "Simulasi",
  signing: "Tanda tangan",
  sending: "Kirim",
  confirming: "Konfirmasi",
  confirmed: "Selesai",
  failed: "Gagal",
};

const SEND_MODES: { value: SendMode; label: string; hint: string }[] = [
  { value: "jito-parallel", label: "Jito + RPC", hint: "Paralel, landing tertinggi" },
  { value: "jito-protected", label: "Jito saja", hint: "Proteksi MEV penuh" },
  { value: "helius-sender", label: "Helius Sender", hint: "Tip ke akun Sender" },
];

function TradeSettings() {
  const swap = useSettingsStore((state) => state.swap);
  const setSwap = useSettingsStore((state) => state.setSwap);
  const panicSlippageBps = useSettingsStore((state) => state.panicSlippageBps);
  const setPanicSlippageBps = useSettingsStore((state) => state.setPanicSlippageBps);
  const slippagePct = swap.slippageBps === "rtse" ? "" : String(swap.slippageBps / 100);

  return (
    <details className="rounded-lg border border-line bg-bg/40" open>
      <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Pengaturan eksekusi
      </summary>
      <div className="grid grid-cols-2 gap-2 px-3 pb-3">
        <Field label="Slippage (%)" hint={swap.slippageBps === "rtse" ? "Auto (RTSE Jupiter)" : undefined}>
          <div className="flex gap-1">
            <Input
              inputMode="decimal"
              value={slippagePct}
              placeholder="auto"
              disabled={swap.slippageBps === "rtse"}
              onChange={(event) => {
                const value = Number(event.target.value.replace(",", "."));
                if (Number.isFinite(value) && value > 0 && value <= 100) setSwap({ slippageBps: Math.round(value * 100) });
              }}
            />
            <Button
              size="md"
              variant={swap.slippageBps === "rtse" ? "primary" : "ghost"}
              onClick={() => setSwap({ slippageBps: swap.slippageBps === "rtse" ? 1_500 : "rtse" })}
              title="Estimasi slippage real-time dari Jupiter"
            >
              Auto
            </Button>
          </div>
        </Field>
        <Field label="Priority fee (SOL)">
          <Input
            inputMode="decimal"
            defaultValue={String(swap.priorityFeeSol)}
            onBlur={(event) => {
              const value = Number(event.target.value.replace(",", "."));
              if (Number.isFinite(value) && value >= 0 && value <= 0.1) setSwap({ priorityFeeSol: value });
              else event.target.value = String(swap.priorityFeeSol);
            }}
          />
        </Field>
        <Field label="Jito tip (SOL)">
          <Input
            inputMode="decimal"
            defaultValue={String(swap.tipSol)}
            onBlur={(event) => {
              const value = Number(event.target.value.replace(",", "."));
              if (Number.isFinite(value) && value >= 0.000001 && value <= 0.1) setSwap({ tipSol: value });
              else event.target.value = String(swap.tipSol);
            }}
          />
        </Field>
        <Field label="Panic slippage (%)">
          <Input
            inputMode="decimal"
            defaultValue={String(panicSlippageBps / 100)}
            onBlur={(event) => {
              const value = Number(event.target.value.replace(",", "."));
              if (Number.isFinite(value) && value > 0 && value <= 100) setPanicSlippageBps(value * 100);
              else event.target.value = String(panicSlippageBps / 100);
            }}
          />
        </Field>
        <div className="col-span-2 flex flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Jalur kirim</span>
          <div className="grid grid-cols-3 gap-1">
            {SEND_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setSwap({ sendMode: mode.value })}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-left transition-colors",
                  swap.sendMode === mode.value ? "border-accent bg-accent/10" : "border-line hover:border-line-strong",
                )}
              >
                <div className="text-[11px] font-semibold text-fg">{mode.label}</div>
                <div className="text-[10px] text-dim">{mode.hint}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="col-span-2 flex flex-wrap gap-4 pt-1">
          <Toggle checked={swap.simulate} onChange={(value) => setSwap({ simulate: value })} label="Simulasi CU" />
          <Toggle checked={swap.fastQuote} onChange={(value) => setSwap({ fastQuote: value })} label="Quote cepat" />
        </div>
      </div>
    </details>
  );
}

function TradeProgress({ mint }: { mint: string }) {
  const active = useTradeStore((state) => state.active);
  const history = useTradeStore((state) => state.history);
  const now = useNow();
  const current = Object.values(active).find((trade) => trade.mint === mint);
  const last = history.find((item) => item.mint === mint);

  if (current) {
    const index = STAGES.indexOf(current.stage);
    return (
      <div className="rounded-md border border-accent/40 bg-accent/5 p-2.5">
        <div className="mb-2 flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1.5 font-semibold text-fg">
            <Spinner className="text-accent" /> {current.side === "buy" ? "Membeli" : "Menjual"} · {current.message}
          </span>
          <span className="font-mono text-dim">{((now - current.startedAt) / 1000).toFixed(1)} dtk</span>
        </div>
        <div className="grid grid-cols-6 gap-1">
          {STAGES.map((stage, i) => (
            <div key={stage} className="flex flex-col items-center gap-1">
              <div className={cn("h-1 w-full rounded-full", i <= index ? "bg-accent" : "bg-line")} />
              <span className={cn("text-[9px]", i <= index ? "text-fg" : "text-dim")}>{STAGE_LABEL[stage]}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (last) {
    return (
      <div className={cn("rounded-md border p-2.5 text-[11px]", last.ok ? "border-up/40 bg-up/5" : "border-down/40 bg-down/5")}>
        <div className="flex items-center justify-between gap-2">
          <span className={cn("font-semibold", last.ok ? "text-up" : "text-down")}>
            {last.ok ? "✓" : "✗"} {last.side === "buy" ? "Beli" : "Jual"} {last.ok ? "berhasil" : "gagal"}
            {last.totalMs !== null ? ` · ${(last.totalMs / 1000).toFixed(1)} dtk` : ""}
          </span>
          <span className="text-dim">{timeAgo(last.finishedAt, now)}</span>
        </div>
        <div className="mt-0.5 break-words text-muted">{last.message}</div>
        {last.explorerUrl ? (
          <a href={last.explorerUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-block text-accent hover:underline">
            Solscan ↗
          </a>
        ) : null}
      </div>
    );
  }
  return null;
}

export function TradePanel({
  mint,
  market,
  position,
  priceSol,
  autoSell,
}: {
  mint: string | null;
  market: MarketData | null;
  position: PositionRow | null;
  priceSol: number | null;
  autoSell: {
    rule: AutoSellRule | null;
    evaluation: AutoSellEvaluationView | undefined;
    engineEnabled: boolean;
    setEngineEnabled: (value: boolean) => void;
  };
}) {
  const [tab, setTab] = useState<"buy" | "sell" | "auto">("buy");
  const [customBuy, setCustomBuy] = useState("");
  const [customSell, setCustomSell] = useState("");
  const walletStatus = useWalletStore((state) => state.status);
  const publicKey = useWalletStore((state) => state.publicKey);
  const solLamports = useWalletStore((state) => state.solLamports);
  const openDialog = useUiStore((state) => state.openDialog);
  const buyPresets = useSettingsStore((state) => state.buyPresetsSol);
  const sellPresets = useSettingsStore((state) => state.sellPresetsPct);
  const swap = useSettingsStore((state) => state.swap);
  const active = useTradeStore((state) => state.active);
  const tokenBalance = useTokenBalance(publicKey, mint);

  const unlocked = walletStatus === "unlocked";
  const busy = Object.values(active).some((trade) => trade.mint === mint);
  const symbol = market?.symbol ?? position?.symbol ?? null;
  const sol = solLamports !== null ? solLamports / 1e9 : null;
  const tokenUi = tokenBalance?.ataUiAmount ?? position?.balanceUi ?? 0;

  const buy = (amount: number | string) => {
    if (!mint) return;
    void performBuy({ mint, solAmount: amount, symbol });
  };
  const sell = (percent: number) => {
    if (!mint) return;
    void performSell({ mint, percent, symbol, source: "manual" });
  };

  const disabledReason = !mint ? "Pilih token dulu" : walletStatus === "none" ? "Buat / import wallet" : !unlocked ? "Wallet terkunci" : null;

  return (
    <Panel
      title="Trade & Automation"
      right={symbol ? <Badge tone="accent">{symbol}</Badge> : null}
      bodyClassName="flex flex-col gap-3"
    >
      <div className="grid grid-cols-3 gap-1 rounded-lg border border-line bg-bg p-1">
        {(["buy", "sell", "auto"] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "rounded-md py-1.5 text-xs font-semibold transition-colors",
              tab === value
                ? value === "buy"
                  ? "bg-up text-black"
                  : value === "sell"
                    ? "bg-down text-white"
                    : "bg-accent text-white"
                : "text-muted hover:text-fg",
            )}
          >
            {value === "buy" ? "Buy" : value === "sell" ? "Sell" : "Auto TP/SL"}
          </button>
        ))}
      </div>

      {disabledReason && tab !== "auto" ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-warn/40 bg-warn/5 px-2.5 py-2 text-xs text-warn">
          <span>{disabledReason}</span>
          {walletStatus === "locked" ? (
            <Button size="xs" variant="primary" onClick={() => openDialog("unlock")}>
              Buka kunci
            </Button>
          ) : walletStatus === "none" ? (
            <Button size="xs" variant="primary" onClick={() => openDialog("create")}>
              Generate
            </Button>
          ) : null}
        </div>
      ) : null}

      {tab === "buy" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>Saldo SOL</span>
            <span className="font-mono text-fg">{formatSol(sol)} SOL</span>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {buyPresets.map((amount) => (
              <Button key={amount} variant="subtle" size="lg" className="font-mono" disabled={Boolean(disabledReason) || busy} onClick={() => buy(amount)}>
                {amount}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder="Custom SOL" value={customBuy} onChange={(event) => setCustomBuy(event.target.value)} className="font-mono" />
            <Button
              variant="buy"
              size="md"
              className="min-w-24"
              loading={busy}
              disabled={Boolean(disabledReason) || !customBuy.trim()}
              onClick={() => buy(customBuy.trim())}
            >
              BUY
            </Button>
          </div>
          {priceSol && customBuy && Number(customBuy.replace(",", ".")) > 0 ? (
            <p className="text-[11px] text-dim">
              Perkiraan ±{formatTokenAmount(Number(customBuy.replace(",", ".")) / priceSol)} {symbol ?? "token"} (sebelum slippage & fee)
            </p>
          ) : null}
        </div>
      ) : null}

      {tab === "sell" ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>Saldo {symbol ?? "token"}</span>
            <span className="font-mono text-fg">
              {formatTokenAmount(tokenUi)}
              {priceSol ? <span className="text-dim"> ≈ {formatSol(tokenUi * priceSol)} SOL</span> : null}
            </span>
          </div>
          {position?.pnlPct !== null && position?.pnlPct !== undefined ? (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">PnL · avg {formatPrice(position.avgPriceSol)} SOL</span>
              <span className={cn("font-mono font-semibold", position.pnlPct >= 0 ? "text-up" : "text-down")}>{formatPct(position.pnlPct)}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-4 gap-1.5">
            {sellPresets.map((percent) => (
              <Button
                key={percent}
                variant={percent === 100 ? "sell" : "subtle"}
                size="lg"
                className="font-mono"
                disabled={Boolean(disabledReason) || busy || tokenUi <= 0}
                onClick={() => sell(percent)}
              >
                {percent}%
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder="Custom %" value={customSell} onChange={(event) => setCustomSell(event.target.value)} className="font-mono" />
            <Button
              variant="sell"
              size="md"
              className="min-w-24"
              loading={busy}
              disabled={Boolean(disabledReason) || tokenUi <= 0 || !(Number(customSell.replace(",", ".")) > 0 && Number(customSell.replace(",", ".")) <= 100)}
              onClick={() => sell(Number(customSell.replace(",", ".")))}
            >
              SELL
            </Button>
          </div>
        </div>
      ) : null}

      {tab === "auto" ? (
        mint ? (
          <AutoSellForm
            key={`${publicKey ?? "none"}:${mint}:${autoSell.rule?.updatedAt ?? 0}`}
            wallet={publicKey}
            mint={mint}
            symbol={symbol}
            rule={autoSell.rule}
            evaluation={autoSell.evaluation}
            engineEnabled={autoSell.engineEnabled}
            onEngineEnabledChange={autoSell.setEngineEnabled}
            hasCostBasis={position?.hasCostBasis ?? false}
            defaultSlippageBps={typeof swap.slippageBps === "number" ? swap.slippageBps : 1_500}
          />
        ) : (
          <p className="text-xs text-dim">Pilih token dulu untuk mengatur Auto TP/SL.</p>
        )
      ) : null}

      {mint ? <TradeProgress mint={mint} /> : null}
      {tab !== "auto" ? <TradeSettings /> : null}
    </Panel>
  );
}
