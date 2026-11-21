"use client";

import { useState } from "react";
import { formatPct, formatPrice } from "@/lib/format";
import type { AutoSellEvaluationView } from "@/hooks/useAutoSell";
import { useAutoSellStore, type AutoSellRule } from "@/store/auto-sell-store";
import { pushToast } from "@/store/toast-store";
import { Badge, Button, Field, Input, Toggle, cn } from "./ui";

interface TpDraft {
  triggerPct: string;
  sellPct: string;
}

interface FormDraft {
  takeProfits: TpDraft[];
  stopLossEnabled: boolean;
  stopLossPct: string;
  stopLossSellPct: string;
  trailingEnabled: boolean;
  trailingActivatePct: string;
  trailingDistancePct: string;
  trailingSellPct: string;
  slippagePct: string;
  manualEntry: string;
}

function draftFromRule(rule: AutoSellRule | null, defaultSlippageBps: number): FormDraft {
  if (!rule) {
    return {
      takeProfits: [{ triggerPct: "100", sellPct: "50" }],
      stopLossEnabled: true,
      stopLossPct: "30",
      stopLossSellPct: "100",
      trailingEnabled: false,
      trailingActivatePct: "50",
      trailingDistancePct: "20",
      trailingSellPct: "100",
      slippagePct: String(Math.max(defaultSlippageBps, 2_500) / 100),
      manualEntry: "",
    };
  }
  return {
    takeProfits: rule.takeProfits.map((level) => ({ triggerPct: String(level.triggerPct), sellPct: String(level.sellPct) })),
    stopLossEnabled: rule.stopLoss !== null,
    stopLossPct: String(rule.stopLoss?.triggerPct ?? 30),
    stopLossSellPct: String(rule.stopLoss?.sellPct ?? 100),
    trailingEnabled: rule.trailing !== null,
    trailingActivatePct: String(rule.trailing?.activatePct ?? 50),
    trailingDistancePct: String(rule.trailing?.distancePct ?? 20),
    trailingSellPct: String(rule.trailing?.sellPct ?? 100),
    slippagePct: String(rule.slippageBps / 100),
    manualEntry: rule.manualEntryPriceSol !== null ? String(rule.manualEntryPriceSol) : "",
  };
}

function parseNumber(value: string): number {
  return Number(value.trim().replace(",", "."));
}

type Validation = { ok: true; value: ReturnType<typeof toRuleConfig> } | { ok: false; error: string };

function toRuleConfig(draft: FormDraft) {
  return {
    takeProfits: draft.takeProfits.map((level) => ({ triggerPct: parseNumber(level.triggerPct), sellPct: parseNumber(level.sellPct) })),
    stopLoss: draft.stopLossEnabled ? { triggerPct: parseNumber(draft.stopLossPct), sellPct: parseNumber(draft.stopLossSellPct) } : null,
    trailing: draft.trailingEnabled
      ? {
          activatePct: parseNumber(draft.trailingActivatePct),
          distancePct: parseNumber(draft.trailingDistancePct),
          sellPct: parseNumber(draft.trailingSellPct),
        }
      : null,
    slippageBps: Math.round(parseNumber(draft.slippagePct) * 100),
    manualEntryPriceSol: draft.manualEntry.trim() ? parseNumber(draft.manualEntry) : null,
  };
}

function validate(draft: FormDraft): Validation {
  const config = toRuleConfig(draft);
  const isPct = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;

  if (config.takeProfits.length === 0 && !config.stopLoss && !config.trailing) {
    return { ok: false, error: "Isi minimal satu: Take Profit, Stop Loss, atau Trailing Stop." };
  }
  for (const level of config.takeProfits) {
    if (!isPct(level.triggerPct, 1, 100_000)) return { ok: false, error: "Target TP harus 1% – 100.000%." };
    if (!isPct(level.sellPct, 1, 100)) return { ok: false, error: "Jumlah jual TP harus 1% – 100%." };
  }
  if (new Set(config.takeProfits.map((level) => level.triggerPct)).size !== config.takeProfits.length) {
    return { ok: false, error: "Target TP tidak boleh sama." };
  }
  if (config.stopLoss) {
    if (!isPct(config.stopLoss.triggerPct, 1, 99)) return { ok: false, error: "Stop Loss harus 1% – 99%." };
    if (!isPct(config.stopLoss.sellPct, 1, 100)) return { ok: false, error: "Jumlah jual SL harus 1% – 100%." };
  }
  if (config.trailing) {
    if (!isPct(config.trailing.activatePct, 0, 100_000)) return { ok: false, error: "Aktivasi trailing harus ≥ 0%." };
    if (!isPct(config.trailing.distancePct, 1, 90)) return { ok: false, error: "Jarak trailing harus 1% – 90%." };
    if (!isPct(config.trailing.sellPct, 1, 100)) return { ok: false, error: "Jumlah jual trailing harus 1% – 100%." };
  }
  if (!isPct(config.slippageBps, 50, 5_000)) return { ok: false, error: "Slippage auto-sell harus 0,5% – 50%." };
  if (config.manualEntryPriceSol !== null && !(config.manualEntryPriceSol > 0)) {
    return { ok: false, error: "Harga masuk manual harus angka > 0 (dalam SOL per token)." };
  }
  return { ok: true, value: config };
}

const STATUS_TEXT: Record<AutoSellEvaluationView["status"], string> = {
  active: "Memantau harga",
  disabled: "Nonaktif",
  "engine-off": "Mesin auto-sell OFF",
  "waiting-position": "Menunggu posisi (beli dulu)",
  "no-entry": "Butuh harga masuk",
  "no-price": "Menunggu harga DexScreener",
  stale: "Harga basi — eksekusi ditahan",
  locked: "Wallet terkunci!",
  cooldown: "Cooldown setelah gagal",
  executing: "Sedang menjual…",
};

function RuleStatus({ rule, evaluation }: { rule: AutoSellRule; evaluation: AutoSellEvaluationView | undefined }) {
  const status = evaluation?.status ?? (rule.enabled ? "no-price" : "disabled");
  const danger = status === "locked" || status === "stale" || status === "cooldown";
  return (
    <div className="rounded-md border border-line bg-bg/60 p-2.5 text-[11px]">
      <div className="mb-1.5 flex items-center justify-between">
        <span className={cn("font-semibold", danger ? "text-down" : status === "active" ? "text-up" : "text-muted")}>
          ● {STATUS_TEXT[status]}
          {evaluation?.pendingConfirmation ? " (konfirmasi tick…)" : ""}
        </span>
        <span className={cn("font-mono text-sm font-bold", (evaluation?.pnlPct ?? 0) >= 0 ? "text-up" : "text-down")}>
          {formatPct(evaluation?.pnlPct ?? null)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-muted">
        <span>Harga masuk</span>
        <span className="text-right font-mono text-fg">
          {formatPrice(evaluation?.entryPriceSol ?? null)} {evaluation?.entrySource === "manual" ? "(manual)" : ""}
        </span>
        <span>Harga kini</span>
        <span className="text-right font-mono text-fg">{formatPrice(evaluation?.priceSol ?? null)}</span>
        {evaluation?.nextTakeProfit ? (
          <>
            <span className="text-up">TP berikut +{evaluation.nextTakeProfit.triggerPct}%</span>
            <span className="text-right font-mono text-up">{formatPrice(evaluation.nextTakeProfit.priceSol)}</span>
          </>
        ) : null}
        {evaluation?.stopLossPriceSol ? (
          <>
            <span className="text-down">Stop loss</span>
            <span className="text-right font-mono text-down">{formatPrice(evaluation.stopLossPriceSol)}</span>
          </>
        ) : null}
        {rule.trailing ? (
          <>
            <span className="text-warn">Trailing {evaluation?.trailingArmed ? "(aktif)" : "(belum aktif)"}</span>
            <span className="text-right font-mono text-warn">{formatPrice(evaluation?.trailingStopPriceSol ?? null)}</span>
          </>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {rule.takeProfits.map((level) => (
          <Badge key={level.id} tone={level.done ? "neutral" : "up"}>
            {level.done ? "✓ " : ""}TP +{level.triggerPct}% → {level.sellPct}%
          </Badge>
        ))}
        {rule.stopLoss ? (
          <Badge tone={rule.stopLoss.done ? "neutral" : "down"}>
            {rule.stopLoss.done ? "✓ " : ""}SL −{rule.stopLoss.triggerPct}% → {rule.stopLoss.sellPct}%
          </Badge>
        ) : null}
        {rule.trailing ? (
          <Badge tone={rule.trailing.done ? "neutral" : "warn"}>
            {rule.trailing.done ? "✓ " : ""}Trail {rule.trailing.distancePct}% → {rule.trailing.sellPct}%
          </Badge>
        ) : null}
        {rule.failures > 0 ? <Badge tone="down">Gagal {rule.failures}x</Badge> : null}
      </div>
    </div>
  );
}

export function AutoSellForm({
  wallet,
  mint,
  symbol,
  rule,
  evaluation,
  engineEnabled,
  onEngineEnabledChange,
  hasCostBasis,
  defaultSlippageBps,
}: {
  wallet: string | null;
  mint: string;
  symbol: string | null;
  rule: AutoSellRule | null;
  evaluation: AutoSellEvaluationView | undefined;
  engineEnabled: boolean;
  onEngineEnabledChange: (value: boolean) => void;
  hasCostBasis: boolean;
  defaultSlippageBps: number;
}) {
  const [draft, setDraft] = useState<FormDraft>(() => draftFromRule(rule, defaultSlippageBps));
  const [error, setError] = useState<string | null>(null);
  const upsertRule = useAutoSellStore((state) => state.upsertRule);
  const setEnabled = useAutoSellStore((state) => state.setEnabled);
  const removeRule = useAutoSellStore((state) => state.removeRule);
  const resetProgress = useAutoSellStore((state) => state.resetProgress);

  const patch = (update: Partial<FormDraft>) => setDraft((current) => ({ ...current, ...update }));
  const patchLevel = (index: number, update: Partial<TpDraft>) =>
    setDraft((current) => ({
      ...current,
      takeProfits: current.takeProfits.map((level, i) => (i === index ? { ...level, ...update } : level)),
    }));

  const save = () => {
    if (!wallet) {
      setError("Buat / import wallet dulu.");
      return;
    }
    const result = validate(draft);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!hasCostBasis && result.value.manualEntryPriceSol === null) {
      setError("Token ini tidak dibeli lewat terminal (tidak ada harga beli rata-rata). Isi harga masuk manual, atau beli lewat terminal.");
      return;
    }
    setError(null);
    upsertRule({ wallet, mint, symbol, enabled: true, ...result.value });
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
    pushToast({ kind: "info", title: `Auto TP/SL aktif · ${symbol ?? mint.slice(0, 4)}`, message: "Biarkan tab ini terbuka agar mesin tetap berjalan." });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Toggle checked={engineEnabled} onChange={onEngineEnabledChange} label={<span className="font-semibold">Mesin Auto-Sell {engineEnabled ? "ON" : "OFF"}</span>} />
        {rule ? (
          <Toggle checked={rule.enabled} onChange={(value) => setEnabled(rule.key, value)} label="Aturan ini" />
        ) : null}
      </div>

      {rule ? <RuleStatus rule={rule} evaluation={evaluation} /> : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-up">Take Profit</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={draft.takeProfits.length >= 4}
            onClick={() => patch({ takeProfits: [...draft.takeProfits, { triggerPct: "", sellPct: "50" }] })}
          >
            + Level
          </Button>
        </div>
        {draft.takeProfits.map((level, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field label={`TP${index + 1} saat naik (%)`}>
              <Input inputMode="decimal" value={level.triggerPct} onChange={(event) => patchLevel(index, { triggerPct: event.target.value })} placeholder="100" />
            </Field>
            <Field label="Jual (% saldo)">
              <Input inputMode="decimal" value={level.sellPct} onChange={(event) => patchLevel(index, { sellPct: event.target.value })} placeholder="50" />
            </Field>
            <Button
              size="md"
              variant="ghost"
              aria-label="Hapus level"
              onClick={() => patch({ takeProfits: draft.takeProfits.filter((_, i) => i !== index) })}
            >
              ✕
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <Toggle checked={draft.stopLossEnabled} onChange={(value) => patch({ stopLossEnabled: value })} label={<span className="font-semibold text-down">Stop Loss</span>} />
        {draft.stopLossEnabled ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Saat turun (%)">
              <Input inputMode="decimal" value={draft.stopLossPct} onChange={(event) => patch({ stopLossPct: event.target.value })} placeholder="30" />
            </Field>
            <Field label="Jual (% saldo)">
              <Input inputMode="decimal" value={draft.stopLossSellPct} onChange={(event) => patch({ stopLossSellPct: event.target.value })} placeholder="100" />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <Toggle checked={draft.trailingEnabled} onChange={(value) => patch({ trailingEnabled: value })} label={<span className="font-semibold text-warn">Trailing Stop</span>} />
        {draft.trailingEnabled ? (
          <div className="grid grid-cols-3 gap-2">
            <Field label="Aktif saat (%)">
              <Input inputMode="decimal" value={draft.trailingActivatePct} onChange={(event) => patch({ trailingActivatePct: event.target.value })} />
            </Field>
            <Field label="Jarak (%)">
              <Input inputMode="decimal" value={draft.trailingDistancePct} onChange={(event) => patch({ trailingDistancePct: event.target.value })} />
            </Field>
            <Field label="Jual (%)">
              <Input inputMode="decimal" value={draft.trailingSellPct} onChange={(event) => patch({ trailingSellPct: event.target.value })} />
            </Field>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Slippage auto-sell (%)" hint="Lebih tinggi = lebih pasti masuk saat dump">
          <Input inputMode="decimal" value={draft.slippagePct} onChange={(event) => patch({ slippagePct: event.target.value })} />
        </Field>
        <Field label="Harga masuk manual (SOL)" hint={hasCostBasis ? "Kosongkan = pakai avg beli" : "Wajib: token dibeli di luar terminal"}>
          <Input inputMode="decimal" value={draft.manualEntry} onChange={(event) => patch({ manualEntry: event.target.value })} placeholder={hasCostBasis ? "otomatis" : "0.0000012"} />
        </Field>
      </div>

      {error ? <p className="text-xs text-down">{error}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" className="flex-1" onClick={save} disabled={!wallet}>
          {rule ? "Simpan & aktifkan ulang" : "Aktifkan Auto TP/SL"}
        </Button>
        {rule ? (
          <>
            <Button variant="ghost" size="md" onClick={() => resetProgress(rule.key)} title="Tandai semua level belum tereksekusi">
              Reset level
            </Button>
            <Button variant="danger" size="md" onClick={() => removeRule(rule.key)}>
              Hapus
            </Button>
          </>
        ) : null}
      </div>
      <p className="text-[10px] leading-relaxed text-dim">
        Berjalan hanya selama tab ini terbuka & komputer menyala. Harga dari DexScreener (±2 dtk, bisa tertinggal beberapa detik dari on-chain);
        saat dump cepat, harga eksekusi SL bisa lebih buruk dari target.
      </p>
    </div>
  );
}
