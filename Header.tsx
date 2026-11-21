"use client";

import { lockWallet } from "@/lib/wallet";
import { formatSol, formatUsd, shortAddress } from "@/lib/format";
import type { RpcHealth } from "@/hooks/useRpcHealth";
import { useWalletStore } from "@/store/wallet-store";
import { useUiStore } from "@/store/ui-store";
import { useSettingsStore } from "@/store/settings-store";
import { Badge, Button, CopyButton, cn } from "./ui";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Meme Terminal";

function RpcPill({ health }: { health: RpcHealth }) {
  const tone = {
    checking: { dot: "bg-muted", text: "text-muted", label: "Menghubungkan…" },
    online: { dot: "bg-up", text: "text-up", label: "RPC Online" },
    slow: { dot: "bg-warn", text: "text-warn", label: "RPC Lambat" },
    offline: { dot: "bg-down", text: "text-down", label: "RPC Offline" },
  }[health.status];

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5"
      title={health.error ?? (health.slot ? `Slot ${health.slot.toLocaleString("en-US")}` : undefined)}
    >
      <span className={cn("h-2 w-2 rounded-full", tone.dot, health.status === "online" && "animate-pulse")} />
      <span className={cn("text-[11px] font-medium", tone.text)}>{tone.label}</span>
      {health.latencyMs !== null ? <span className="font-mono text-[11px] text-dim">{health.latencyMs} ms</span> : null}
    </div>
  );
}

export function Header({ rpcHealth, solUsd, activeAutoSell }: { rpcHealth: RpcHealth; solUsd: number | null; activeAutoSell: number }) {
  const status = useWalletStore((state) => state.status);
  const publicKey = useWalletStore((state) => state.publicKey);
  const solLamports = useWalletStore((state) => state.solLamports);
  const openDialog = useUiStore((state) => state.openDialog);
  const soundEnabled = useSettingsStore((state) => state.soundEnabled);
  const setSoundEnabled = useSettingsStore((state) => state.setSoundEnabled);

  const sol = solLamports !== null ? solLamports / 1e9 : null;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-2 px-3 py-2">
        <div className="mr-2 flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded-md bg-accent font-mono text-sm font-bold text-white">◆</div>
          <span className="text-sm font-semibold tracking-tight text-fg">{APP_NAME}</span>
          <Badge tone="accent">Solana</Badge>
        </div>

        <RpcPill health={rpcHealth} />

        {activeAutoSell > 0 ? (
          <Badge tone="up" className="hidden sm:inline-flex">
            ● Auto TP/SL aktif: {activeAutoSell}
          </Badge>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {publicKey ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-panel px-2.5 py-1">
              <span className={cn("h-2 w-2 rounded-full", status === "unlocked" ? "bg-up" : "bg-warn")} title={status === "unlocked" ? "Terbuka" : "Terkunci"} />
              <div className="flex flex-col leading-tight">
                <span className="font-mono text-xs tabular-nums text-fg">{formatSol(sol, 4)} SOL</span>
                <span className="font-mono text-[10px] text-dim">{sol !== null && solUsd !== null ? formatUsd(sol * solUsd) : "—"}</span>
              </div>
              <span className="hidden font-mono text-[11px] text-muted md:inline">{shortAddress(publicKey, 4)}</span>
              <CopyButton value={publicKey} label="" />
            </div>
          ) : null}

          {status === "none" ? (
            <>
              <Button size="sm" variant="primary" onClick={() => openDialog("create")}>
                + Generate Wallet
              </Button>
              <Button size="sm" variant="outline" onClick={() => openDialog("import")}>
                Import
              </Button>
            </>
          ) : (
            <>
              {status === "locked" ? (
                <Button size="sm" variant="primary" onClick={() => openDialog("unlock")}>
                  🔓 Buka Kunci
                </Button>
              ) : (
                <Button size="sm" variant="subtle" onClick={() => lockWallet()} title="Kunci wallet (keypair dihapus dari memori)">
                  🔒 Kunci
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => openDialog("export")}>
                Export Key
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openDialog("create")} title="Generate wallet baru">
                Generate
              </Button>
              <Button size="sm" variant="ghost" onClick={() => openDialog("import")}>
                Import
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => openDialog("access-key")} title="Kunci akses API (TERMINAL_ACCESS_KEY)">
            🔑
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSoundEnabled(!soundEnabled)} title={soundEnabled ? "Matikan suara" : "Nyalakan suara"}>
            {soundEnabled ? "🔊" : "🔇"}
          </Button>
        </div>
      </div>
    </header>
  );
}
