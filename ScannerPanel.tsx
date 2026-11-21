"use client";

import { useState, type ClipboardEvent, type FormEvent } from "react";
import { isValidPublicKey } from "@/lib/rpc";
import { formatCompactNumber, formatPct, formatPrice, formatUsd, formatUsdCompact, pnlTone, shortAddress } from "@/lib/format";
import type { MarketData, RiskLevel } from "@/lib/scanner";
import type { TokenScanView } from "@/hooks/useTokenScan";
import { Badge, Button, CopyButton, Input, Panel, Spinner, Stat, cn } from "./ui";

const RISK_STYLE: Record<RiskLevel, { tone: "up" | "down" | "warn" | "neutral"; ring: string }> = {
  ok: { tone: "up", ring: "border-up/50" },
  caution: { tone: "warn", ring: "border-warn/50" },
  warning: { tone: "down", ring: "border-down/50" },
  danger: { tone: "down", ring: "border-down" },
  unknown: { tone: "neutral", ring: "border-line" },
};

function CheckRow({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-line/60 py-1.5 last:border-b-0">
      <span className="text-xs text-muted">{label}</span>
      <span className="flex flex-col items-end">
        <span className={cn("text-xs font-semibold", ok === null ? "text-dim" : ok ? "text-up" : "text-down")}>
          {ok === null ? "—" : ok ? "✓ Aman" : "✗ Bahaya"}
        </span>
        {detail ? <span className="max-w-[220px] truncate font-mono text-[10px] text-dim">{detail}</span> : null}
      </span>
    </div>
  );
}

function SecurityCard({ scan }: { scan: TokenScanView }) {
  const result = scan.result;
  const security = result?.security ?? null;
  const holders = result?.holders ?? null;
  const risk = result?.risk ?? null;
  const style = RISK_STYLE[risk?.level ?? "unknown"];
  const top10 = holders?.top10PercentExcludingPools ?? null;

  return (
    <div className={cn("rounded-lg border bg-bg/50 p-3", style.ring)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Skor keamanan</span>
        <div className="flex items-center gap-2">
          {scan.loading ? <Spinner className="text-muted" /> : null}
          {risk ? <Badge tone={style.tone}>{risk.label}</Badge> : null}
          <Button size="xs" variant="ghost" onClick={scan.rescan} disabled={scan.loading}>
            ↻ Scan ulang
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-md border border-line bg-panel p-2 text-center">
          <div className="text-[10px] uppercase text-dim">Mint</div>
          <div className={cn("text-sm font-bold", security ? (security.mintAuthorityRevoked ? "text-up" : "text-down") : "text-dim")}>
            {security ? (security.mintAuthorityRevoked ? "Revoked" : "AKTIF") : "—"}
          </div>
        </div>
        <div className="rounded-md border border-line bg-panel p-2 text-center">
          <div className="text-[10px] uppercase text-dim">Freeze</div>
          <div className={cn("text-sm font-bold", security ? (security.freezeAuthorityRevoked ? "text-up" : "text-down") : "text-dim")}>
            {security ? (security.freezeAuthorityRevoked ? "Revoked" : "AKTIF") : "—"}
          </div>
        </div>
        <div className="rounded-md border border-line bg-panel p-2 text-center">
          <div className="text-[10px] uppercase text-dim">Top 10</div>
          <div
            className={cn(
              "font-mono text-sm font-bold",
              top10 === null ? "text-dim" : top10 > 50 ? "text-down" : top10 > 30 ? "text-warn" : "text-up",
            )}
          >
            {top10 === null ? "—" : `${top10.toFixed(1)}%`}
          </div>
        </div>
      </div>

      <div className="mt-2">
        <CheckRow ok={security ? security.mintAuthorityRevoked : null} label="Mint authority null" detail={security?.mintAuthority ?? undefined} />
        <CheckRow ok={security ? security.freezeAuthorityRevoked : null} label="Freeze authority null" detail={security?.freezeAuthority ?? undefined} />
        <CheckRow
          ok={holders ? holders.largestNonPoolPercent <= 10 : null}
          label="Holder terbesar (non-pool)"
          detail={holders?.largestNonPool ? `${holders.largestNonPoolPercent.toFixed(2)}% · ${shortAddress(holders.largestNonPool.owner)}` : undefined}
        />
        <CheckRow
          ok={security ? !security.extensions.some((finding) => finding.severity === "critical" || finding.severity === "high") : null}
          label={`Program: ${security?.tokenProgram ?? "—"}`}
          detail={security && security.extensionTypes.length > 0 ? security.extensionTypes.join(", ") : undefined}
        />
      </div>

      {risk && risk.flags.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {risk.flags.slice(0, 6).map((flag) => (
            <li key={flag.id} className="flex items-start gap-1.5 text-[11px]">
              <span
                className={cn(
                  "mt-1 h-1.5 w-1.5 shrink-0 rounded-full",
                  flag.severity === "critical" || flag.severity === "high" ? "bg-down" : flag.severity === "medium" ? "bg-warn" : "bg-dim",
                )}
              />
              <span className="text-muted">
                <span className="text-fg">{flag.title}.</span> {flag.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {scan.error ? <p className="mt-2 text-xs text-down">{scan.error}</p> : null}
    </div>
  );
}

function HoldersTable({ scan }: { scan: TokenScanView }) {
  const holders = scan.result?.holders;
  if (!holders || holders.holders.length === 0) return null;
  return (
    <details className="rounded-lg border border-line bg-bg/40">
      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted hover:text-fg">
        Top {holders.holders.length} holder · pool {holders.poolPercent.toFixed(1)}% · burn {holders.burnedPercent.toFixed(1)}%
      </summary>
      <div className="overflow-x-auto px-3 pb-2">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-dim">
              <th className="py-1 font-medium">#</th>
              <th className="py-1 font-medium">Owner</th>
              <th className="py-1 font-medium">Tipe</th>
              <th className="py-1 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody>
            {holders.holders.map((holder) => (
              <tr key={holder.owner} className="border-t border-line/50">
                <td className="py-1 text-dim">{holder.rank}</td>
                <td className="py-1 font-mono">
                  <a href={`https://solscan.io/account/${holder.owner}`} target="_blank" rel="noreferrer noopener" className="hover:text-accent">
                    {shortAddress(holder.owner)}
                  </a>
                  {holder.tokenAccounts.length > 1 ? <span className="ml-1 text-dim">×{holder.tokenAccounts.length}</span> : null}
                </td>
                <td className="py-1">
                  <Badge tone={holder.category === "liquidity-pool" ? "accent" : holder.category === "burn" ? "neutral" : holder.category === "program-pda" ? "warn" : "neutral"}>
                    {holder.label ?? (holder.category === "wallet" ? "Wallet" : holder.category)}
                  </Badge>
                </td>
                <td className={cn("py-1 text-right font-mono tabular-nums", holder.category === "wallet" && holder.percent > 10 ? "text-down" : "text-fg")}>
                  {holder.percent.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function MarketStats({ market }: { market: MarketData | null }) {
  if (!market) {
    return <p className="text-xs text-dim">Menunggu data DexScreener…</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat label="Harga" value={formatPrice(market.priceUsd, "$")} sub={market.priceInSol !== null ? `${formatPrice(market.priceInSol)} SOL` : undefined} />
      <Stat label="Market cap" value={formatUsdCompact(market.marketCapUsd ?? market.fdvUsd)} sub={`FDV ${formatUsdCompact(market.fdvUsd)}`} />
      <Stat label="Likuiditas" value={formatUsdCompact(market.liquidityUsd)} sub={market.isBondingCurve ? "bonding curve" : market.dexId} />
      <Stat label="Volume 1j" value={formatUsdCompact(market.volumeUsd.h1)} sub={`5m ${formatUsdCompact(market.volumeUsd.m5)}`} />
      <Stat label="Δ 5m" value={formatPct(market.priceChangePct.m5)} tone={pnlTone(market.priceChangePct.m5)} />
      <Stat label="Δ 1j" value={formatPct(market.priceChangePct.h1)} tone={pnlTone(market.priceChangePct.h1)} />
      <Stat label="Tx 5m (B/S)" value={`${market.txns.m5.buys}/${market.txns.m5.sells}`} sub={`1j ${formatCompactNumber(market.txns.h1.buys)}/${formatCompactNumber(market.txns.h1.sells)}`} />
      <Stat label="Umur pair" value={market.pairAgeMinutes !== null ? (market.pairAgeMinutes < 120 ? `${market.pairAgeMinutes} mnt` : `${Math.round(market.pairAgeMinutes / 60)} jam`) : "—"} sub={`Vol 24j ${formatUsd(market.volumeUsd.h24)}`} />
    </div>
  );
}

export function ScannerPanel({
  mint,
  onSelectMint,
  scan,
  market,
}: {
  mint: string | null;
  onSelectMint: (mint: string) => void;
  scan: TokenScanView;
  market: MarketData | null;
}) {
  const [input, setInput] = useState(mint ?? "");
  const [inputError, setInputError] = useState<string | null>(null);

  const submit = (value: string) => {
    const trimmed = value.trim();
    if (!isValidPublicKey(trimmed)) {
      setInputError("Contract Address tidak valid (harus alamat Base58 Solana).");
      return;
    }
    setInputError(null);
    setInput(trimmed);
    onSelectMint(trimmed);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text").trim();
    if (isValidPublicKey(pasted)) {
      event.preventDefault();
      submit(pasted);
    }
  };

  const symbol = market?.symbol ?? scan.result?.market?.symbol ?? null;

  return (
    <Panel
      title="Token Scanner"
      right={mint ? <a className="text-[11px] text-accent hover:underline" href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noreferrer noopener">DexScreener ↗</a> : null}
      bodyClassName="flex flex-col gap-3"
    >
      <form
        className="flex gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit(input);
        }}
      >
        <Input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onPaste={onPaste}
          placeholder="Tempel Contract Address (CA) token Solana…"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button type="submit" variant="primary">
          Scan
        </Button>
      </form>
      {inputError ? <p className="-mt-1 text-xs text-down">{inputError}</p> : null}

      {mint ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {market?.imageUrl ? <img src={market.imageUrl} alt="" className="h-8 w-8 rounded-full border border-line" referrerPolicy="no-referrer" /> : null}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg">{symbol ?? "…"}</span>
                <span className="truncate text-xs text-muted">{market?.name ?? scan.result?.market?.name ?? ""}</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="font-mono text-[11px] text-dim">{shortAddress(mint, 6)}</span>
                <CopyButton value={mint} label="CA" />
              </div>
            </div>
          </div>

          <MarketStats market={market ?? scan.result?.market ?? null} />

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="overflow-hidden rounded-lg border border-line bg-bg">
              <iframe
                key={mint}
                title={`Grafik ${symbol ?? mint}`}
                src={`https://dexscreener.com/solana/${mint}?embed=1&theme=dark`}
                className="h-[420px] w-full md:h-[480px]"
                loading="lazy"
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                allow="clipboard-write"
              />
            </div>
            <div className="flex flex-col gap-3">
              <SecurityCard scan={scan} />
              <HoldersTable scan={scan} />
            </div>
          </div>
        </>
      ) : (
        <div className="grid h-60 place-items-center rounded-lg border border-dashed border-line text-center text-xs text-dim">
          Tempel CA token di atas untuk melihat grafik live, data market, dan skor keamanan on-chain.
        </div>
      )}
    </Panel>
  );
}
