/**
 * src/lib/rpc.ts — Koneksi RPC & helper bersama
 *
 * Dipakai oleh wallet.ts, scanner.ts, dan swap.ts:
 * - Singleton `Connection` ke Helius (HTTP + WebSocket)
 * - Cache metadata mint (program SPL Token / Token-2022, decimals, supply, authority)
 * - Konversi jumlah presisi (BigInt) antara satuan mentah (raw) dan satuan tampilan (UI)
 * - fetchJson dengan timeout & pesan error yang jelas
 */

import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint, type Mint } from "@solana/spl-token";

// ---------------------------------------------------------------------------
// Konstanta jaringan
// ---------------------------------------------------------------------------

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const SOL_DECIMALS = 9;
export const DEFAULT_COMMITMENT: Commitment = "confirmed";

/** Variabel NEXT_PUBLIC_ harus ditulis literal agar di-inline oleh Next.js saat build. */
const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "";
const WS_URL = process.env.NEXT_PUBLIC_HELIUS_WS_URL ?? "";

export const HELIUS_SENDER_URL =
  process.env.NEXT_PUBLIC_HELIUS_SENDER_URL || "https://sender.helius-rpc.com/fast";

export const DEXSCREENER_API_URL = (
  process.env.NEXT_PUBLIC_DEXSCREENER_API_URL || "https://api.dexscreener.com"
).replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Error umum
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export class NotATokenMintError extends Error {
  readonly address: string;

  constructor(address: string, detail: string) {
    super(`Alamat ${address} bukan mint SPL token yang valid: ${detail}`);
    this.name = "NotATokenMintError";
    this.address = address;
  }
}

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

let connectionSingleton: Connection | null = null;

export function getRpcUrl(): string {
  if (!RPC_URL) {
    throw new Error(
      "NEXT_PUBLIC_HELIUS_RPC_URL belum diisi. Isi di .env.local (lokal) atau di dashboard Vercel/Netlify.",
    );
  }
  return RPC_URL;
}

/**
 * Satu Connection untuk seluruh aplikasi agar WebSocket tidak dibuka berkali-kali.
 * disableRetryOnRateLimit = true: untuk trading kita lebih suka gagal cepat dan
 * menangani retry sendiri daripada menunggu backoff bawaan web3.js.
 */
export function getConnection(): Connection {
  if (connectionSingleton) return connectionSingleton;
  connectionSingleton = new Connection(getRpcUrl(), {
    commitment: DEFAULT_COMMITMENT,
    wsEndpoint: WS_URL || undefined,
    disableRetryOnRateLimit: true,
    confirmTransactionInitialTimeout: 60_000,
  });
  return connectionSingleton;
}

// ---------------------------------------------------------------------------
// Validasi alamat
// ---------------------------------------------------------------------------

const BASE58_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidPublicKey(value: string): boolean {
  const trimmed = value.trim();
  if (!BASE58_ADDRESS_REGEX.test(trimmed)) return false;
  try {
    new PublicKey(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function toPublicKey(value: PublicKey | string, label = "Alamat"): PublicKey {
  if (value instanceof PublicKey) return value;
  const trimmed = value.trim();
  if (!isValidPublicKey(trimmed)) {
    throw new Error(`${label} tidak valid: "${trimmed}"`);
  }
  return new PublicKey(trimmed);
}

// ---------------------------------------------------------------------------
// Konversi jumlah (presisi BigInt, tanpa error floating point)
// ---------------------------------------------------------------------------

/**
 * Ubah jumlah tampilan (mis. "0.05" SOL) menjadi satuan mentah (lamports / unit token).
 * Digit desimal yang melebihi `decimals` dipotong (dibulatkan ke bawah) agar
 * tidak pernah membelanjakan lebih dari yang diketik user.
 * Menerima koma sebagai pemisah desimal ("0,5") bila tidak ada titik.
 */
export function uiToRaw(value: number | string, decimals: number): bigint {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Jumlah tidak valid: ${value}`);
    }
    text = value.toFixed(Math.min(Math.max(decimals, 0), 20));
  } else {
    text = value.trim();
    if (!text.includes(".") && text.includes(",")) text = text.replace(",", ".");
  }

  if (text === "" || text === "." || !/^\d*(\.\d*)?$/.test(text)) {
    throw new Error(`Jumlah tidak valid: "${value}"`);
  }

  const [integerPart = "0", fractionPart = ""] = text.split(".");
  const fraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");
  const base = 10n ** BigInt(decimals);
  return BigInt(integerPart === "" ? "0" : integerPart) * base + BigInt(fraction === "" ? "0" : fraction);
}

/** Ubah satuan mentah menjadi angka tampilan. Presisi penuh hingga batas Number JS. */
export function rawToUiAmount(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const integerPart = absolute / base;
  const fractionPart = absolute % base;
  const value = Number(`${integerPart.toString()}.${fractionPart.toString().padStart(decimals, "0")}`);
  return negative ? -value : value;
}

export function lamportsToSol(lamports: bigint | number): number {
  return rawToUiAmount(typeof lamports === "bigint" ? lamports : BigInt(Math.trunc(lamports)), SOL_DECIMALS);
}

// ---------------------------------------------------------------------------
// Metadata mint (dengan cache)
// ---------------------------------------------------------------------------

export interface MintMeta {
  mint: PublicKey;
  programId: PublicKey;
  isToken2022: boolean;
  decimals: number;
  supplyRaw: bigint;
  mintAuthority: PublicKey | null;
  freezeAuthority: PublicKey | null;
  /** Objek Mint lengkap dari @solana/spl-token (berisi tlvData untuk ekstensi Token-2022). */
  account: Mint;
  slot: number;
  fetchedAt: number;
}

const mintMetaCache = new Map<string, MintMeta>();

/**
 * Ambil info mint. `programId` & `decimals` tidak pernah berubah, jadi aman di-cache.
 * Supply & authority BISA berubah — scanner selalu memanggil dengan forceRefresh: true.
 */
export async function getMintMeta(
  mint: PublicKey | string,
  options: { forceRefresh?: boolean } = {},
): Promise<MintMeta> {
  const mintPk = toPublicKey(mint, "Contract Address");
  const key = mintPk.toBase58();
  const cached = mintMetaCache.get(key);
  if (cached && !options.forceRefresh) return cached;

  const { value: info, context } = await getConnection().getAccountInfoAndContext(mintPk, "confirmed");
  if (!info) {
    throw new NotATokenMintError(key, "akun tidak ditemukan on-chain");
  }

  let programId: PublicKey;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) {
    programId = TOKEN_PROGRAM_ID;
  } else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    programId = TOKEN_2022_PROGRAM_ID;
  } else {
    throw new NotATokenMintError(key, `dimiliki program ${info.owner.toBase58()}, bukan SPL Token / Token-2022`);
  }

  let account: Mint;
  try {
    account = unpackMint(mintPk, info, programId);
  } catch (error) {
    throw new NotATokenMintError(key, `data mint tidak bisa dibaca (${toError(error).message})`);
  }

  if (!account.isInitialized) {
    throw new NotATokenMintError(key, "mint belum di-inisialisasi");
  }

  const meta: MintMeta = {
    mint: mintPk,
    programId,
    isToken2022: programId.equals(TOKEN_2022_PROGRAM_ID),
    decimals: account.decimals,
    supplyRaw: account.supply,
    mintAuthority: account.mintAuthority,
    freezeAuthority: account.freezeAuthority,
    account,
    slot: context.slot,
    fetchedAt: Date.now(),
  };
  mintMetaCache.set(key, meta);
  return meta;
}

// ---------------------------------------------------------------------------
// fetchJson dengan timeout
// ---------------------------------------------------------------------------

function extractErrorMessage(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") return body.slice(0, 300);
  if (typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
    if (typeof record.message === "string") return record.message;
  }
  return null;
}

export interface FetchJsonOptions extends RequestInit {
  timeoutMs?: number;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 8_000, signal: externalSignal, ...init } = options;
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      throw new HttpError(extractErrorMessage(body) ?? `HTTP ${response.status}`, response.status, body);
    }
    return body as T;
  } catch (error) {
    if (timedOut) {
      throw new HttpError(`Request ke ${new URL(url, "http://localhost").host} timeout setelah ${timeoutMs} ms`, 408, null);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}
