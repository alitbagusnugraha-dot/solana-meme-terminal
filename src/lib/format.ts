/**
 * src/lib/format.ts — Format angka untuk tampilan terminal.
 * Semua fungsi menerima null/undefined dan mengembalikan "—".
 */

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function toSubscript(value: number): string {
  return String(value)
    .split("")
    .map((digit) => SUBSCRIPT_DIGITS[Number(digit)] ?? digit)
    .join("");
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Harga dengan notasi nol subskrip ala GMGN/Axiom:
 * 0.00000123 → "0.0₅123", 0.0123 → "0.0123", 12.3456 → "12.3456".
 */
export function formatPrice(value: number | null | undefined, prefix = ""): string {
  if (!isNumber(value)) return "—";
  if (value === 0) return `${prefix}0`;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs >= 1_000) return `${sign}${prefix}${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (abs >= 1) return `${sign}${prefix}${abs.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  if (abs >= 0.0001) return `${sign}${prefix}${Number(abs.toPrecision(4)).toString()}`;

  let exponent = Math.floor(Math.log10(abs));
  let mantissa = Number((abs / 10 ** exponent).toFixed(3));
  if (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }
  const zeros = -exponent - 1;
  const digits = mantissa.toFixed(3).replace(".", "").replace(/0+$/, "") || "0";
  return `${sign}${prefix}0.0${toSubscript(zeros)}${digits}`;
}

export function formatSol(value: number | null | undefined, maxDigits = 4): string {
  if (!isNumber(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, maxDigits),
    maximumFractionDigits: maxDigits,
  });
}

const compactUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatUsdCompact(value: number | null | undefined): string {
  if (!isNumber(value)) return "—";
  return compactUsd.format(value);
}

export function formatUsd(value: number | null | undefined): string {
  if (!isNumber(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  });
}

export function formatPct(value: number | null | undefined, digits = 2): string {
  if (!isNumber(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

export function formatTokenAmount(value: number | null | undefined): string {
  if (!isNumber(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  }
  if (abs >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return formatPrice(value);
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (!isNumber(value)) return "—";
  return value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

export function shortAddress(address: string | null | undefined, size = 4): string {
  if (!address) return "—";
  if (address.length <= size * 2 + 1) return address;
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}

export function timeAgo(timestamp: number | null | undefined, now: number): string {
  if (!isNumber(timestamp) || timestamp <= 0) return "—";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} dtk lalu`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} mnt lalu`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} jam lalu`;
  return `${Math.round(hours / 24)} hari lalu`;
}

export function pnlTone(value: number | null | undefined): "up" | "down" | "flat" {
  if (!isNumber(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}
