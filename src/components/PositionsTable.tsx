"use client";

import type { ReactNode } from "react";
import { formatPct, formatPrice, formatSol, formatTokenAmount, formatUsd, pnlTone, timeAgo } from "@/lib/format";
import type { PositionRow, PositionsView } from "@/hooks/usePositions";
import type { AutoSellEvaluationView } from "@/hooks/useAutoSell";
import { useNow } from "@/hooks/useNow";
import { Badge, Button, Panel, Spinner, cn } from "./ui";

function PnlText({ value, children }: { value: number | null; children: ReactNode }) {
  const tone = pnlTone(value);
  return <span className={cn("font-mono tabular-nums", tone === "up" && "text-up", tone === "down" && "text-down", tone === "flat" && "text-muted")}>{children}</span>;
}

function AutoBadge({ evaluation }: { evaluation: AutoSellEvaluationView | undefined }) {
  if (!evaluation) return <span className="text-[11px] text-dim">—</span>;
  const map: Partial<Record<AutoSellEvaluationView["status"], { tone: "up" | "down" | "warn" | "neutral" | "accent"; label: string }>> = {
    active: { tone: "up", label: "Aktif" },
    executing: { tone: "accent", label: "Menjual…" },
    locked: { tone: "down", label: "Wallet terkunci" },
    stale: { tone: "warn", label: "Harga basi" },
    cooldown: { tone: "warn", label: "Cooldown" },
    "no-entry": { tone: "warn", label: "Tanpa harga masuk" },
    "no-price": { tone: "warn", label: "Tanpa harga" },
    disabled: { tone: "neutral", label: "Mati" },
    "engine-off": { tone: "neutral", label: "Mesin OFF" },
    "waiting-position": { tone: "neutral", label: "Menunggu posisi" },
  };
  const entry = map[evaluation.status] ?? { tone: "neutral" as const, label: evaluation.status };
  return <Badge tone={entry.tone}>{evaluation.pendingConfirmation ? "Konfirmasi…" : entry.label}</Badge>;
}

export function PositionsTable({
  view,
  evaluations,
  executingMints,
  selectedMint,
  walletUnlocked,
  onSelect,
  onPanicSell,
}: {
  view: PositionsView;
  evaluations: Record<string, AutoSellEvaluationView>;
  executingMints: string[];
  selectedMint: string | null;
  walletUnlocked: boolean;
  onSelect: (mint: string) => void;
  onPanicSell: (row: PositionRow) => void;
}) {
  const now = useNow();
  const { rows, totals } = view;

  return (
    <Panel
      title={`Posisi aktif (${rows.length})`}
      right={
        <div className="flex items-center gap-3 text-[11px]">
          {view.loading ? <Spinner className="text-muted" /> : null}
          <span className="text-dim">Nilai</span>
          <span className="font-mono text-fg">{formatSol(totals.valueSol)} SOL</span>
          <span className="hidden text-dim sm:inline">{formatUsd(totals.valueUsd)}</span>
          <span className="text-dim">uPnL</span>
          <PnlText value={totals.unrealizedSol}>{formatSol(totals.unrealizedSol)} SOL</PnlText>
          <span className="hidden text-dim md:inline">Realized</span>
          <span className="hidden md:inline">
            <PnlText value={totals.realizedSol}>{formatSol(totals.realizedSol)} SOL</PnlText>
          </span>
          <span className="hidden text-dim lg:inline">· {timeAgo(view.updatedAt, now)}</span>
        </div>
      }
      bodyClassName="p-0"
    >
      {view.error ? <p className="px-3 py-2 text-xs text-down">{view.error}</p> : null}
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-dim">{view.loading ? "Memuat saldo token…" : "Belum ada token di burner wallet."}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-dim">
                <th className="px-3 py-2 font-medium">Token</th>
                <th className="px-3 py-2 text-right font-medium">Saldo</th>
                <th className="px-3 py-2 text-right font-medium">Avg beli (SOL)</th>
                <th className="px-3 py-2 text-right font-medium">Harga kini (SOL)</th>
                <th className="px-3 py-2 text-right font-medium">Nilai</th>
                <th className="px-3 py-2 text-right font-medium">PnL %</th>
                <th className="px-3 py-2 text-right font-medium">PnL SOL</th>
                <th className="px-3 py-2 font-medium">Auto TP/SL</th>
                <th className="px-3 py-2 text-right font-medium">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const executing = executingMints.includes(row.mint);
                return (
                  <tr
                    key={row.mint}
                    className={cn("border-b border-line/60 transition-colors hover:bg-panel-2/60", selectedMint === row.mint && "bg-accent/5")}
                  >
                    <td className="px-3 py-2">
                      <button type="button" className="flex items-center gap-2 text-left" onClick={() => onSelect(row.mint)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {row.imageUrl ? <img src={row.imageUrl} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" /> : <span className="h-6 w-6 rounded-full bg-panel-2" />}
                        <span className="flex flex-col">
                          <span className="font-semibold text-fg hover:text-accent">{row.symbol}</span>
                          <span className="text-[10px] text-dim">
                            <PnlText value={row.priceChange5m}>5m {formatPct(row.priceChange5m, 1)}</PnlText>
                          </span>
                        </span>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">{formatTokenAmount(row.balanceUi)}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted">
                      {row.avgPriceSol !== null ? formatPrice(row.avgPriceSol) : <span title="Bukan dibeli lewat terminal ini">—</span>}
                      {row.estimatedCost ? <span className="ml-1 text-warn" title="Sebagian dihitung dari quote (estimasi)">~</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-fg">{formatPrice(row.priceSol)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="font-mono tabular-nums text-fg">{formatSol(row.valueSol)}</div>
                      <div className="font-mono text-[10px] text-dim">{formatUsd(row.valueUsd)}</div>
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-semibold">
                      <PnlText value={row.pnlPct}>{formatPct(row.pnlPct)}</PnlText>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PnlText value={row.unrealizedSol}>{formatSol(row.unrealizedSol)}</PnlText>
                      {row.realizedSol !== 0 ? (
                        <div className="text-[10px]">
                          <span className="text-dim">real. </span>
                          <PnlText value={row.realizedSol}>{formatSol(row.realizedSol)}</PnlText>
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <AutoBadge evaluation={evaluations[row.mint]} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button size="xs" variant="ghost" onClick={() => onSelect(row.mint)}>
                          Pilih
                        </Button>
                        <Button
                          size="xs"
                          variant="sell"
                          loading={executing}
                          disabled={!walletUnlocked || executing}
                          onClick={() => onPanicSell(row)}
                          title={walletUnlocked ? "Jual 100% sekarang dengan slippage panic" : "Buka kunci wallet dulu"}
                        >
                          Panic Sell 100%
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
