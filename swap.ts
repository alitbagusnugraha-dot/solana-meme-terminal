/**
 * src/lib/swap.ts — Jupiter Swap API V2 + Jito Ultra-Fast Swap Engine
 *
 * Alur satu klik Buy/Sell:
 *  1. BUILD    — GET /api/jupiter/build (proxy server → api.jup.ag/swap/v2/build).
 *                Jupiter mengembalikan instruksi mentah + quote + blockhash dalam
 *                satu panggilan (pengganti /v6/quote + /v6/swap yang sudah dihentikan).
 *                Bersamaan dengan itu, saldo SOL/token dicek (paralel, tanpa menambah latensi).
 *  2. ASSEMBLE — Rakit VersionedTransaction v0 sendiri:
 *                [setComputeUnitLimit, setComputeUnitPrice, ...setup, swap, cleanup,
 *                 ...other, (closeAccount), tip SOL → akun tip + akun jitodontfront].
 *                Address Lookup Table dibentuk dari respons Jupiter (tanpa RPC tambahan).
 *  3. SIMULATE — Simulasi sekali untuk mengukur compute unit (CU) yang sebenarnya,
 *                lalu CU limit diset ±20% di atasnya. Priority fee (total SOL yang
 *                Anda atur) dibagi CU limit → harga per CU lebih tinggi = prioritas
 *                lebih tinggi untuk biaya yang sama. Simulasi juga menggagalkan lebih
 *                awal transaksi yang pasti gagal (slippage, saldo kurang) sebelum bayar fee.
 *  4. SIGN     — Ditandatangani lokal dengan burner wallet (milidetik, tanpa pop-up).
 *  5. SEND     — Dikirim PARALEL sesuai mode:
 *                • jito-parallel  : Jito Block Engine (via /api/jito/send) + Helius RPC
 *                • jito-protected : hanya Jito, bundleOnly=true (revert protection)
 *                • helius-sender  : Helius Sender + Helius RPC (tip ke akun tip Sender)
 *                Signature sama di semua jalur, jadi transaksi hanya bisa masuk SATU kali.
 *  6. CONFIRM  — WebSocket signatureSubscribe + polling getSignatureStatuses, sambil
 *                mengirim ulang (rebroadcast) tiap ±1,8 detik sampai confirmed atau
 *                blockhash kedaluwarsa.
 *  7. RESULT   — Jumlah token & SOL AKTUAL dibaca dari meta transaksi (bukan dari quote)
 *                untuk PnL yang akurat.
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionError,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { Buffer } from "buffer";
import {
  HELIUS_SENDER_URL,
  HttpError,
  NotATokenMintError,
  SOL_DECIMALS,
  WSOL_MINT,
  fetchJson,
  getConnection,
  getMintMeta,
  rawToUiAmount,
  sleep,
  toError,
  toPublicKey,
  uiToRaw,
} from "./rpc";
import { WalletError, getTokenBalance, getUnlockedKeypair, touchWalletSession } from "./wallet";

// ===========================================================================
// Konstanta
// ===========================================================================

/** 8 akun tip resmi Jito Block Engine (dari getTipAccounts). Dipilih acak per transaksi. */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;

/** Akun tip Helius Sender (BERBEDA dari akun tip Jito). Wajib untuk mode helius-sender. */
export const HELIUS_SENDER_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
] as const;

/**
 * Akun "jitodontfront": block engine Jito menolak bundle apa pun yang menaruh
 * transaksi lain SEBELUM transaksi Anda → mencegah front-run/sandwich di jalur Jito.
 * Ditambahkan sebagai akun read-only ke instruksi tip (System Program mengabaikannya).
 */
export const JITO_DONT_FRONT_ACCOUNT = new PublicKey("jitodontfront111111111111111111111111111111");

const MAX_TRANSACTION_BYTES = 1_232;
const MAX_COMPUTE_UNITS = 1_400_000;
const FALLBACK_COMPUTE_UNITS = 400_000;
const MIN_COMPUTE_UNITS = 20_000;
const CU_SAFETY_MULTIPLIER = 1.2;
const SIMULATION_TIMEOUT_MS = 1_500;

const JITO_MIN_TIP_LAMPORTS = 1_000n;
const SENDER_FULL_ROUTING_MIN_TIP_LAMPORTS = 1_000_000n;
const MAX_PRIORITY_FEE_SOL = 0.1;
const MAX_TIP_SOL = 0.1;

/** Rent ATA token baru + rent akun WSOL sementara + base fee. Harus tersedia saat Buy. */
const BUY_SOL_RESERVE_LAMPORTS = 4_100_000n;
/** Rent akun WSOL sementara (dikembalikan di akhir tx) + base fee. Harus tersedia saat Sell. */
const SELL_SOL_RESERVE_LAMPORTS = 2_100_000n;

const REBROADCAST_INTERVAL_MS = 1_800;
const STATUS_POLL_INTERVAL_MS = 400;
const BLOCK_HEIGHT_CHECK_INTERVAL_MS = 2_000;
const CONFIRM_TIMEOUT_MS = 90_000;

const ACCESS_KEY_STORAGE = "smt:terminal-access-key";

// ===========================================================================
// Tipe publik
// ===========================================================================

export type SendMode = "jito-parallel" | "jito-protected" | "helius-sender";
export type SwapSide = "buy" | "sell";

export interface SwapSettings {
  /** Basis points (1500 = 15%) atau "rtse" = estimasi slippage real-time oleh Jupiter. */
  slippageBps: number | "rtse";
  /** Total priority fee per transaksi dalam SOL. */
  priorityFeeSol: number;
  /** Tip ke validator (Jito / Helius Sender) dalam SOL. */
  tipSol: number;
  sendMode: SendMode;
  /** Simulasi untuk CU limit akurat & gagal-cepat. Nonaktifkan untuk hemat ±100–300 ms. */
  simulate: boolean;
  /** mode=fast di Jupiter: sedikit mengorbankan optimalitas rute demi latensi lebih rendah. */
  fastQuote: boolean;
  /** Tutup ATA saat jual 100% untuk menarik kembali rent ±0,002 SOL (hanya SPL Token klasik). */
  closeTokenAccountOnFullSell: boolean;
}

export type SwapStage =
  | "preparing"
  | "building"
  | "simulating"
  | "signing"
  | "sending"
  | "confirming"
  | "confirmed"
  | "failed";

export interface SwapStatusUpdate {
  stage: SwapStage;
  message: string;
  elapsedMs: number;
  signature?: string;
}

export type SwapErrorCode =
  | "WALLET_LOCKED"
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "RATE_LIMITED"
  | "INSUFFICIENT_SOL"
  | "NO_TOKEN_BALANCE"
  | "NO_ROUTE"
  | "BUILD_FAILED"
  | "TX_TOO_LARGE"
  | "SIMULATION_FAILED"
  | "SLIPPAGE_EXCEEDED"
  | "SEND_FAILED"
  | "TX_FAILED"
  | "EXPIRED"
  | "TIMEOUT";

export class SwapError extends Error {
  readonly code: SwapErrorCode;
  readonly stage: SwapStage;
  readonly signature: string | null;
  readonly logs: string[] | null;
  readonly transactionError: TransactionError | null;

  constructor(
    code: SwapErrorCode,
    message: string,
    details: {
      stage?: SwapStage;
      signature?: string | null;
      logs?: string[] | null;
      transactionError?: TransactionError | null;
    } = {},
  ) {
    super(message);
    this.name = "SwapError";
    this.code = code;
    this.stage = details.stage ?? "failed";
    this.signature = details.signature ?? null;
    this.logs = details.logs ?? null;
    this.transactionError = details.transactionError ?? null;
  }
}

export interface SwapQuoteSummary {
  inputMint: string;
  outputMint: string;
  inAmountRaw: bigint;
  outAmountRaw: bigint;
  /** Jumlah minimum output setelah slippage (otherAmountThreshold). */
  minOutAmountRaw: bigint;
  priceImpactPct: number;
  slippageBps: number;
  routeLabels: string[];
}

export interface ExecutedAmounts {
  /** Perubahan saldo token (positif saat beli, negatif saat jual). */
  tokenDeltaRaw: bigint;
  tokenDeltaUi: number;
  /** Perubahan saldo SOL wallet bersih (sudah termasuk fee, tip, rent). */
  walletSolDeltaLamports: bigint;
  /** SOL murni untuk swap (negatif = dibelanjakan, positif = diterima), di luar fee/tip/rent. */
  swapSolLamports: bigint;
  networkFeeLamports: bigint;
  tipLamports: bigint;
  /** Rent yang masuk ke token account (positif saat ATA dibuat, negatif saat ATA ditutup). */
  tokenAccountRentDeltaLamports: bigint;
  /** Harga eksekusi riil dalam SOL per token. */
  effectivePriceSol: number | null;
  slot: number;
  blockTime: number | null;
}

export type SendPath = "jito" | "helius-rpc" | "helius-sender";

export interface SendPathResult {
  path: SendPath;
  ok: boolean;
  latencyMs: number;
  attempt: number;
  error?: string;
  bundleId?: string | null;
  endpoint?: string | null;
}

export interface SwapResult {
  signature: string;
  side: SwapSide;
  mint: string;
  /** Decimals token (untuk menghitung harga per token & PnL). */
  tokenDecimals: number;
  sendMode: SendMode;
  slot: number;
  confirmationStatus: "confirmed" | "finalized";
  quote: SwapQuoteSummary;
  executed: ExecutedAmounts | null;
  fees: {
    priorityFeeLamports: bigint;
    computeUnitLimit: number;
    computeUnitsConsumed: number | null;
    computeUnitPriceMicroLamports: bigint;
    tipLamports: bigint;
    tipAccount: string;
  };
  paths: SendPathResult[];
  timings: {
    buildMs: number;
    simulateMs: number;
    signMs: number;
    firstSendMs: number;
    confirmMs: number;
    totalMs: number;
  };
  warnings: string[];
  explorerUrl: string;
}

// ===========================================================================
// Default settings dari env
// ===========================================================================

function readEnvNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnvSendMode(value: string | undefined): SendMode {
  switch ((value ?? "").trim()) {
    case "jito-parallel":
    case "jito-protected":
    case "helius-sender":
      return value!.trim() as SendMode;
    // Kompatibel dengan nilai lama dari .env.example tahap 1
    case "jito":
      return "jito-protected";
    case "sender":
      return "helius-sender";
    default:
      return "jito-parallel";
  }
}

export const DEFAULT_SWAP_SETTINGS: SwapSettings = {
  slippageBps: readEnvNumber(process.env.NEXT_PUBLIC_DEFAULT_SLIPPAGE_BPS, 1_500),
  priorityFeeSol: readEnvNumber(process.env.NEXT_PUBLIC_DEFAULT_PRIORITY_FEE_SOL, 0.0005),
  tipSol: readEnvNumber(process.env.NEXT_PUBLIC_DEFAULT_JITO_TIP_SOL, 0.001),
  sendMode: readEnvSendMode(process.env.NEXT_PUBLIC_DEFAULT_SEND_MODE),
  simulate: true,
  fastQuote: true,
  closeTokenAccountOnFullSell: true,
};

interface ResolvedSettings extends SwapSettings {
  priorityFeeLamports: bigint;
  tipLamports: bigint;
  warnings: string[];
}

export function resolveSwapSettings(partial: Partial<SwapSettings> = {}): ResolvedSettings {
  const settings: SwapSettings = { ...DEFAULT_SWAP_SETTINGS, ...partial };
  const warnings: string[] = [];

  if (settings.slippageBps !== "rtse") {
    if (!Number.isInteger(settings.slippageBps) || settings.slippageBps < 1 || settings.slippageBps > 10_000) {
      throw new SwapError("INVALID_INPUT", "Slippage harus 1–10000 bps (0,01%–100%) atau 'rtse'.");
    }
    if (settings.slippageBps > 3_000) {
      warnings.push(`Slippage ${settings.slippageBps / 100}% sangat tinggi — sandwich bot bisa mengambil sampai sebesar itu.`);
    }
  }

  if (!Number.isFinite(settings.priorityFeeSol) || settings.priorityFeeSol < 0 || settings.priorityFeeSol > MAX_PRIORITY_FEE_SOL) {
    throw new SwapError("INVALID_INPUT", `Priority fee harus 0–${MAX_PRIORITY_FEE_SOL} SOL (pengaman salah ketik).`);
  }
  if (!Number.isFinite(settings.tipSol) || settings.tipSol < 0 || settings.tipSol > MAX_TIP_SOL) {
    throw new SwapError("INVALID_INPUT", `Tip harus 0–${MAX_TIP_SOL} SOL (pengaman salah ketik).`);
  }

  const priorityFeeLamports = uiToRaw(settings.priorityFeeSol, SOL_DECIMALS);
  const tipLamports = uiToRaw(settings.tipSol, SOL_DECIMALS);

  if (settings.sendMode !== "helius-sender" && tipLamports < JITO_MIN_TIP_LAMPORTS) {
    throw new SwapError("INVALID_INPUT", "Jito mensyaratkan tip minimal 1.000 lamports (0,000001 SOL).");
  }
  if (settings.sendMode === "helius-sender") {
    if (tipLamports < 5_000n) {
      throw new SwapError("INVALID_INPUT", "Helius Sender mensyaratkan tip minimal 0,000005 SOL.");
    }
    if (tipLamports < SENDER_FULL_ROUTING_MIN_TIP_LAMPORTS) {
      warnings.push("Tip < 0,001 SOL: Helius Sender mengirim best-effort lewat jalur lebih sedikit.");
    }
  }

  return { ...settings, priorityFeeLamports, tipLamports, warnings };
}

// ===========================================================================
// Kunci akses API routes
// ===========================================================================

export function setTerminalAccessKey(key: string | null): void {
  if (typeof window === "undefined") return;
  if (key && key.trim()) window.localStorage.setItem(ACCESS_KEY_STORAGE, key.trim());
  else window.localStorage.removeItem(ACCESS_KEY_STORAGE);
}

export function getTerminalAccessKey(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACCESS_KEY_STORAGE);
}

function apiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...extra };
  const accessKey = getTerminalAccessKey();
  if (accessKey) headers["x-terminal-key"] = accessKey;
  return headers;
}

// ===========================================================================
// Jupiter /build
// ===========================================================================

export interface JupiterInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

export interface JupiterBuildResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: {
    swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string };
    percent: number;
    bps: number;
  }[];
  computeBudgetInstructions: JupiterInstruction[];
  setupInstructions: JupiterInstruction[];
  swapInstruction: JupiterInstruction;
  cleanupInstruction: JupiterInstruction | null;
  otherInstructions: JupiterInstruction[];
  tipInstruction?: JupiterInstruction | null;
  addressesByLookupTableAddress: Record<string, string[]> | null;
  transactionVersion?: number;
  blockhashWithMetadata: {
    blockhash: number[];
    lastValidBlockHeight: number;
  };
}

function isJupiterBuildResponse(value: unknown): value is JupiterBuildResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  const blockhash = body.blockhashWithMetadata as Record<string, unknown> | undefined;
  const swap = body.swapInstruction as Record<string, unknown> | undefined;
  return (
    typeof body.inAmount === "string" &&
    typeof body.outAmount === "string" &&
    typeof body.otherAmountThreshold === "string" &&
    !!swap &&
    typeof swap.programId === "string" &&
    Array.isArray(swap.accounts) &&
    typeof swap.data === "string" &&
    Array.isArray(body.setupInstructions) &&
    !!blockhash &&
    Array.isArray(blockhash.blockhash) &&
    typeof blockhash.lastValidBlockHeight === "number"
  );
}

async function requestJupiterBuild(params: {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountRaw: bigint;
  taker: PublicKey;
  settings: ResolvedSettings;
  maxAccounts?: number;
}): Promise<JupiterBuildResponse> {
  const query = new URLSearchParams({
    inputMint: params.inputMint.toBase58(),
    outputMint: params.outputMint.toBase58(),
    amount: params.amountRaw.toString(),
    taker: params.taker.toBase58(),
    slippageBps: String(params.settings.slippageBps),
    wrapAndUnwrapSol: "true",
  });
  if (params.settings.fastQuote) query.set("mode", "fast");
  if (params.settings.sendMode === "jito-protected") query.set("forJitoBundle", "true");
  if (params.maxAccounts) query.set("maxAccounts", String(params.maxAccounts));

  let body: unknown;
  try {
    body = await fetchJson<unknown>(`/api/jupiter/build?${query.toString()}`, {
      headers: apiHeaders(),
      timeoutMs: 8_000,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      if (error.status === 401) {
        throw new SwapError("UNAUTHORIZED", "Kunci akses terminal salah/kosong. Isi TERMINAL_ACCESS_KEY di layar Unlock.", { stage: "building" });
      }
      if (error.status === 429) {
        throw new SwapError("RATE_LIMITED", "Jupiter membatasi request (tier gratis 1 req/detik). Tunggu sebentar lalu ulangi.", { stage: "building" });
      }
      if (/no route/i.test(error.message)) {
        throw new SwapError("NO_ROUTE", "Jupiter tidak menemukan rute untuk token ini (likuiditas kosong atau token belum bisa diperdagangkan).", { stage: "building" });
      }
      throw new SwapError("BUILD_FAILED", `Jupiter /build gagal: ${error.message}`, { stage: "building" });
    }
    throw new SwapError("BUILD_FAILED", `Jupiter /build gagal: ${toError(error).message}`, { stage: "building" });
  }

  if (!isJupiterBuildResponse(body)) {
    throw new SwapError("BUILD_FAILED", "Format respons Jupiter /build tidak dikenali.", { stage: "building" });
  }
  return body;
}

// ===========================================================================
// Perakitan transaksi
// ===========================================================================

function toTransactionInstruction(instruction: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
}

function toLookupTableAccounts(map: Record<string, string[]> | null | undefined): AddressLookupTableAccount[] {
  if (!map) return [];
  return Object.entries(map).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: undefined,
          addresses: addresses.map((address) => new PublicKey(address)),
        },
      }),
  );
}

export function decodeJupiterBlockhash(build: JupiterBuildResponse): string {
  const bytes = Uint8Array.from(build.blockhashWithMetadata.blockhash);
  if (bytes.length !== 32) {
    throw new SwapError("BUILD_FAILED", `Blockhash dari Jupiter tidak valid (${bytes.length} byte).`, { stage: "building" });
  }
  return bs58.encode(bytes);
}

/** Priority fee total (lamports) → harga per CU (micro-lamports). Minimal 1 (wajib untuk Helius Sender). */
export function computeUnitPriceFromFee(priorityFeeLamports: bigint, computeUnitLimit: number): bigint {
  if (computeUnitLimit <= 0) return 1n;
  const price = (priorityFeeLamports * 1_000_000n) / BigInt(computeUnitLimit);
  return price > 0n ? price : 1n;
}

export function pickTipAccount(mode: SendMode, random: () => number = Math.random): PublicKey {
  const list = mode === "helius-sender" ? HELIUS_SENDER_TIP_ACCOUNTS : JITO_TIP_ACCOUNTS;
  const index = Math.min(list.length - 1, Math.floor(random() * list.length));
  return new PublicKey(list[index]!);
}

export interface AssembleParams {
  build: JupiterBuildResponse;
  payer: PublicKey;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: bigint;
  tipLamports: bigint;
  tipAccount: PublicKey;
  extraInstructions?: TransactionInstruction[];
}

/**
 * Rakit transaksi v0. computeBudgetInstructions dari Jupiter SENGAJA dibuang
 * (isinya hanya harga CU) dan diganti milik kita: CU limit hasil simulasi +
 * harga CU dari priority fee yang Anda atur. Tip diletakkan TERAKHIR supaya
 * bila swap gagal, tip ikut batal (tidak terbayar).
 */
export function assembleSwapTransaction(params: AssembleParams): VersionedTransaction {
  const tipInstruction = SystemProgram.transfer({
    fromPubkey: params.payer,
    toPubkey: params.tipAccount,
    lamports: params.tipLamports,
  });
  tipInstruction.keys.push({ pubkey: JITO_DONT_FRONT_ACCOUNT, isSigner: false, isWritable: false });

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: params.computeUnitPriceMicroLamports }),
    ...params.build.setupInstructions.map(toTransactionInstruction),
    toTransactionInstruction(params.build.swapInstruction),
    ...(params.build.cleanupInstruction ? [toTransactionInstruction(params.build.cleanupInstruction)] : []),
    ...(params.build.otherInstructions ?? []).map(toTransactionInstruction),
    ...(params.extraInstructions ?? []),
    tipInstruction,
  ];

  const message = new TransactionMessage({
    payerKey: params.payer,
    recentBlockhash: decodeJupiterBlockhash(params.build),
    instructions,
  }).compileToV0Message(toLookupTableAccounts(params.build.addressesByLookupTableAddress));

  return new VersionedTransaction(message);
}

// ===========================================================================
// Klasifikasi error transaksi
// ===========================================================================

export function classifyFailure(
  transactionError: TransactionError | null | undefined,
  logs: string[] | null | undefined,
): { code: SwapErrorCode; message: string } {
  const haystack = `${(logs ?? []).join("\n")}\n${JSON.stringify(transactionError ?? null)}`.toLowerCase();

  if (
    /slippage|toolittlesolreceived|toomuchsolrequired|exceeds desired slippage|0x1771|"custom":6001/.test(haystack)
  ) {
    return {
      code: "SLIPPAGE_EXCEEDED",
      message: "Harga bergerak melebihi slippage. Naikkan slippage atau ulangi dengan quote baru.",
    };
  }
  if (/insufficient lamports|insufficientfundsforrent|insufficientfundsforfee|insufficient funds for fee/.test(haystack)) {
    return { code: "INSUFFICIENT_SOL", message: "Saldo SOL tidak cukup untuk jumlah + fee + tip + rent akun." };
  }
  if (/computational budget exceeded|exceeded cus meter|computationalbudgetexceeded/.test(haystack)) {
    return { code: "TX_FAILED", message: "Compute unit habis. Aktifkan simulasi atau ulangi transaksi." };
  }
  if (/bondingcurvecomplete|bonding curve complete/.test(haystack)) {
    return {
      code: "TX_FAILED",
      message: "Bonding curve pump.fun sudah selesai (sedang migrasi ke AMM). Tunggu beberapa detik lalu ulangi.",
    };
  }
  if (/error: insufficient funds|"custom":1\}/.test(haystack)) {
    return { code: "NO_TOKEN_BALANCE", message: "Saldo token tidak cukup untuk dijual." };
  }
  if (/blockhash not found|blockhashnotfound/.test(haystack)) {
    return { code: "EXPIRED", message: "Blockhash kedaluwarsa. Ulangi transaksi." };
  }
  return {
    code: "TX_FAILED",
    message: `Transaksi gagal: ${transactionError ? JSON.stringify(transactionError) : "tanpa detail error"}`,
  };
}

// ===========================================================================
// Simulasi compute unit
// ===========================================================================

interface SimulationOutcome {
  unitsConsumed: number | null;
  transactionError: TransactionError | null;
  logs: string[] | null;
  skipped: boolean;
}

async function simulateForComputeUnits(transaction: VersionedTransaction): Promise<SimulationOutcome> {
  const connection = getConnection();
  const simulation = connection
    .simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "processed",
    })
    .then((response) => ({
      unitsConsumed: response.value.unitsConsumed ?? null,
      transactionError: response.value.err,
      logs: response.value.logs ?? null,
      skipped: false,
    }))
    .catch(() => ({ unitsConsumed: null, transactionError: null, logs: null, skipped: true }));

  const timeout = sleep(SIMULATION_TIMEOUT_MS).then(() => ({
    unitsConsumed: null,
    transactionError: null,
    logs: null,
    skipped: true,
  }));

  return Promise.race([simulation, timeout]);
}

// ===========================================================================
// Pengiriman paralel
// ===========================================================================

async function sendViaHeliusRpc(rawTransaction: Uint8Array, attempt: number): Promise<SendPathResult> {
  const started = performance.now();
  try {
    await getConnection().sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 0 });
    return { path: "helius-rpc", ok: true, latencyMs: Math.round(performance.now() - started), attempt };
  } catch (error) {
    return {
      path: "helius-rpc",
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      attempt,
      error: toError(error).message,
    };
  }
}

async function sendViaHeliusSender(base64Transaction: string, attempt: number): Promise<SendPathResult> {
  const started = performance.now();
  try {
    const body = await fetchJson<{ result?: string; error?: { message?: string } }>(HELIUS_SENDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `smt-${Date.now()}-${attempt}`,
        method: "sendTransaction",
        params: [base64Transaction, { encoding: "base64", skipPreflight: true, maxRetries: 0 }],
      }),
      timeoutMs: 4_000,
    });
    if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
    return { path: "helius-sender", ok: true, latencyMs: Math.round(performance.now() - started), attempt };
  } catch (error) {
    return {
      path: "helius-sender",
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      attempt,
      error: toError(error).message,
    };
  }
}

async function sendViaJito(base64Transaction: string, bundleOnly: boolean, attempt: number): Promise<SendPathResult> {
  const started = performance.now();
  try {
    const body = await fetchJson<{ signature?: string; bundleId?: string | null; endpoint?: string }>("/api/jito/send", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ transaction: base64Transaction, bundleOnly }),
      timeoutMs: 6_000,
    });
    return {
      path: "jito",
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      attempt,
      bundleId: body.bundleId ?? null,
      endpoint: body.endpoint ?? null,
    };
  } catch (error) {
    return {
      path: "jito",
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      attempt,
      error: toError(error).message,
    };
  }
}

function waitForFirstSuccess(tasks: Promise<SendPathResult>[]): Promise<SendPathResult> {
  return new Promise((resolve, reject) => {
    if (tasks.length === 0) {
      reject(new Error("Tidak ada jalur pengiriman."));
      return;
    }
    let remaining = tasks.length;
    const failures: SendPathResult[] = [];
    for (const task of tasks) {
      void task.then((result) => {
        if (result.ok) {
          resolve(result);
          return;
        }
        failures.push(result);
        remaining -= 1;
        if (remaining === 0) {
          reject(new Error(failures.map((f) => `${f.path}: ${f.error ?? "gagal"}`).join(" | ")));
        }
      });
    }
  });
}

function createSender(mode: SendMode, rawTransaction: Uint8Array, base64Transaction: string, paths: SendPathResult[]) {
  let attempt = 0;
  const record = (task: Promise<SendPathResult>) =>
    task.then((result) => {
      paths.push(result);
      return result;
    });

  const initial = (): Promise<SendPathResult> => {
    attempt += 1;
    const tasks: Promise<SendPathResult>[] = [];
    if (mode === "jito-parallel") {
      tasks.push(record(sendViaJito(base64Transaction, false, attempt)));
      tasks.push(record(sendViaHeliusRpc(rawTransaction, attempt)));
    } else if (mode === "jito-protected") {
      tasks.push(record(sendViaJito(base64Transaction, true, attempt)));
    } else {
      tasks.push(record(sendViaHeliusSender(base64Transaction, attempt)));
      tasks.push(record(sendViaHeliusRpc(rawTransaction, attempt)));
    }
    return waitForFirstSuccess(tasks);
  };

  /**
   * Rebroadcast menghormati rate limit: Jito publik 1 req/detik per IP per region,
   * jadi di mode jito-parallel rebroadcast hanya lewat Helius RPC.
   */
  const rebroadcast = async (): Promise<void> => {
    attempt += 1;
    if (mode === "jito-parallel") {
      await record(sendViaHeliusRpc(rawTransaction, attempt));
    } else if (mode === "jito-protected") {
      await record(sendViaJito(base64Transaction, true, attempt));
    } else {
      await Promise.all([
        record(sendViaHeliusSender(base64Transaction, attempt)),
        record(sendViaHeliusRpc(rawTransaction, attempt)),
      ]);
    }
  };

  return { initial, rebroadcast };
}

// ===========================================================================
// Konfirmasi + rebroadcast
// ===========================================================================

async function confirmWithRebroadcast(params: {
  signature: string;
  lastValidBlockHeight: number;
  rebroadcast: () => Promise<void>;
}): Promise<{ slot: number; confirmationStatus: "confirmed" | "finalized" }> {
  const connection = getConnection();
  const started = Date.now();
  const websocket: { result: { err: TransactionError | null; slot: number } | null } = { result: null };
  let subscriptionId: number | null = null;

  try {
    subscriptionId = connection.onSignature(
      params.signature,
      (result, context) => {
        websocket.result = { err: result.err, slot: context.slot };
      },
      "confirmed",
    );
  } catch {
    subscriptionId = null;
  }

  let lastRebroadcast = Date.now();
  let lastHeightCheck = 0;

  try {
    for (;;) {
      if (websocket.result) {
        if (websocket.result.err) {
          throw new SwapError("TX_FAILED", "Transaksi masuk blok tapi GAGAL dieksekusi.", {
            stage: "confirming",
            signature: params.signature,
            transactionError: websocket.result.err,
          });
        }
        return { slot: websocket.result.slot, confirmationStatus: "confirmed" };
      }

      try {
        const { value } = await connection.getSignatureStatuses([params.signature]);
        const status = value[0];
        if (status) {
          if (status.err) {
            throw new SwapError("TX_FAILED", "Transaksi masuk blok tapi GAGAL dieksekusi.", {
              stage: "confirming",
              signature: params.signature,
              transactionError: status.err,
            });
          }
          if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
            return { slot: status.slot, confirmationStatus: status.confirmationStatus };
          }
        }
      } catch (error) {
        if (error instanceof SwapError) throw error;
        // error RPC sementara (rate limit/jaringan) — lanjutkan polling
      }

      const now = Date.now();

      if (now - lastHeightCheck >= BLOCK_HEIGHT_CHECK_INTERVAL_MS) {
        lastHeightCheck = now;
        try {
          const blockHeight = await connection.getBlockHeight("confirmed");
          if (blockHeight > params.lastValidBlockHeight) {
            const { value } = await connection.getSignatureStatuses([params.signature], {
              searchTransactionHistory: true,
            });
            const finalStatus = value[0];
            if (finalStatus && !finalStatus.err && finalStatus.confirmationStatus) {
              return {
                slot: finalStatus.slot,
                confirmationStatus: finalStatus.confirmationStatus === "finalized" ? "finalized" : "confirmed",
              };
            }
            throw new SwapError(
              "EXPIRED",
              "Blockhash kedaluwarsa sebelum transaksi masuk blok. Naikkan priority fee/tip lalu ulangi.",
              { stage: "confirming", signature: params.signature },
            );
          }
        } catch (error) {
          if (error instanceof SwapError) throw error;
        }
      }

      if (now - lastRebroadcast >= REBROADCAST_INTERVAL_MS) {
        lastRebroadcast = now;
        void params.rebroadcast().catch(() => undefined);
      }

      if (now - started > CONFIRM_TIMEOUT_MS) {
        throw new SwapError("TIMEOUT", "Konfirmasi melebihi 90 detik. Cek status transaksi di explorer.", {
          stage: "confirming",
          signature: params.signature,
        });
      }

      await sleep(STATUS_POLL_INTERVAL_MS);
    }
  } finally {
    if (subscriptionId !== null) {
      void connection.removeSignatureListener(subscriptionId).catch(() => undefined);
    }
  }
}

async function fetchFailureLogs(signature: string): Promise<string[] | null> {
  try {
    const transaction = await getConnection().getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return transaction?.meta?.logMessages ?? null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Jumlah aktual dari meta transaksi
// ===========================================================================

export async function fetchExecutedAmounts(params: {
  signature: string;
  owner: PublicKey;
  mint: PublicKey;
  decimals: number;
  tipLamports: bigint;
  attempts?: number;
}): Promise<ExecutedAmounts | null> {
  const connection = getConnection();
  const owner = params.owner.toBase58();
  const mint = params.mint.toBase58();
  const attempts = params.attempts ?? 8;

  for (let i = 0; i < attempts; i += 1) {
    let transaction: Awaited<ReturnType<typeof connection.getTransaction>> | null = null;
    try {
      transaction = await connection.getTransaction(params.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      transaction = null;
    }

    const meta = transaction?.meta;
    if (transaction && meta) {
      const pre = meta.preTokenBalances ?? [];
      const post = meta.postTokenBalances ?? [];
      const isOwned = (entry: { mint: string; owner?: string }) => entry.mint === mint && entry.owner === owner;

      const sumRaw = (entries: typeof pre) =>
        entries.filter(isOwned).reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount.amount), 0n);
      const tokenDeltaRaw = sumRaw(post) - sumRaw(pre);

      const tokenAccountIndexes = new Set<number>([
        ...pre.filter(isOwned).map((entry) => entry.accountIndex),
        ...post.filter(isOwned).map((entry) => entry.accountIndex),
      ]);
      let tokenAccountRentDeltaLamports = 0n;
      for (const index of tokenAccountIndexes) {
        const before = meta.preBalances[index];
        const after = meta.postBalances[index];
        if (before !== undefined && after !== undefined) {
          tokenAccountRentDeltaLamports += BigInt(after) - BigInt(before);
        }
      }

      const payerBefore = meta.preBalances[0] ?? 0;
      const payerAfter = meta.postBalances[0] ?? 0;
      const walletSolDeltaLamports = BigInt(payerAfter) - BigInt(payerBefore);
      const networkFeeLamports = BigInt(meta.fee);
      const swapSolLamports =
        walletSolDeltaLamports + networkFeeLamports + params.tipLamports + tokenAccountRentDeltaLamports;

      const tokenDeltaUi = rawToUiAmount(tokenDeltaRaw, params.decimals);
      const swapSolUi = rawToUiAmount(swapSolLamports < 0n ? -swapSolLamports : swapSolLamports, SOL_DECIMALS);
      const tokenAbs = Math.abs(tokenDeltaUi);

      return {
        tokenDeltaRaw,
        tokenDeltaUi,
        walletSolDeltaLamports,
        swapSolLamports,
        networkFeeLamports,
        tipLamports: params.tipLamports,
        tokenAccountRentDeltaLamports,
        effectivePriceSol: tokenAbs > 0 ? swapSolUi / tokenAbs : null,
        slot: transaction.slot,
        blockTime: transaction.blockTime ?? null,
      };
    }
    await sleep(400);
  }
  return null;
}

// ===========================================================================
// Inti eksekusi
// ===========================================================================

interface ExecutionPlan {
  side: SwapSide;
  mint: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountRaw: bigint;
  signer: Keypair;
  settings: ResolvedSettings;
  extraInstructions: TransactionInstruction[];
  /** Cek saldo yang berjalan paralel dengan /build. Mengembalikan decimals token. */
  preflight: Promise<{ tokenDecimals: number }>;
  onStatus?: (update: SwapStatusUpdate) => void;
  startedAt: number;
}

/** Bungkus runSwap agar setiap kegagalan dilaporkan ke UI sebagai stage "failed". */
async function executeSwap(plan: ExecutionPlan): Promise<SwapResult> {
  try {
    return await runSwap(plan);
  } catch (error) {
    const swapError =
      error instanceof SwapError ? error : new SwapError("TX_FAILED", toError(error).message, { stage: "failed" });
    plan.onStatus?.({
      stage: "failed",
      message: swapError.message,
      elapsedMs: Date.now() - plan.startedAt,
      signature: swapError.signature ?? undefined,
    });
    throw swapError;
  }
}

async function runSwap(plan: ExecutionPlan): Promise<SwapResult> {
  const { settings, signer } = plan;
  const warnings = [...settings.warnings];
  const report = (stage: SwapStage, message: string, signature?: string) => {
    plan.onStatus?.({ stage, message, elapsedMs: Date.now() - plan.startedAt, signature });
  };

  const tipAccount = pickTipAccount(settings.sendMode);

  // ---- 1. BUILD (dengan fallback ukuran transaksi) ----
  report("building", "Mengambil rute & instruksi dari Jupiter…");
  const buildStarted = performance.now();
  let build: JupiterBuildResponse | null = null;
  let draft: VersionedTransaction | null = null;
  let tokenDecimals = 0;

  const maxAccountsSteps = [undefined, 40, 28] as const;
  for (const [stepIndex, maxAccounts] of maxAccountsSteps.entries()) {
    // Tier gratis Jupiter = 1 req/detik: beri jeda sebelum build ulang (jarang terjadi).
    if (stepIndex > 0) await sleep(1_100);
    const [candidate, preflight] = await Promise.all([
      requestJupiterBuild({
        inputMint: plan.inputMint,
        outputMint: plan.outputMint,
        amountRaw: plan.amountRaw,
        taker: signer.publicKey,
        settings,
        maxAccounts,
      }),
      plan.preflight,
    ]);
    tokenDecimals = preflight.tokenDecimals;

    const candidateTx = assembleSwapTransaction({
      build: candidate,
      payer: signer.publicKey,
      computeUnitLimit: MAX_COMPUTE_UNITS,
      computeUnitPriceMicroLamports: computeUnitPriceFromFee(settings.priorityFeeLamports, MAX_COMPUTE_UNITS),
      tipLamports: settings.tipLamports,
      tipAccount,
      extraInstructions: plan.extraInstructions,
    });

    if (candidateTx.serialize().length <= MAX_TRANSACTION_BYTES) {
      build = candidate;
      draft = candidateTx;
      break;
    }
  }
  const buildMs = Math.round(performance.now() - buildStarted);

  if (!build || !draft) {
    throw new SwapError("TX_TOO_LARGE", "Rute Jupiter terlalu besar untuk satu transaksi meski akun dibatasi. Coba jumlah lain.", {
      stage: "building",
    });
  }

  // ---- 2. SIMULATE (CU limit akurat) ----
  let computeUnitLimit = FALLBACK_COMPUTE_UNITS;
  let computeUnitsConsumed: number | null = null;
  let simulateMs = 0;

  if (settings.simulate) {
    report("simulating", "Simulasi compute unit…");
    const simulationStarted = performance.now();
    const outcome = await simulateForComputeUnits(draft);
    simulateMs = Math.round(performance.now() - simulationStarted);

    if (outcome.transactionError) {
      const failure = classifyFailure(outcome.transactionError, outcome.logs);
      throw new SwapError(failure.code === "TX_FAILED" ? "SIMULATION_FAILED" : failure.code, `Simulasi gagal: ${failure.message}`, {
        stage: "simulating",
        logs: outcome.logs,
        transactionError: outcome.transactionError,
      });
    }

    if (outcome.unitsConsumed && outcome.unitsConsumed > 0) {
      computeUnitsConsumed = outcome.unitsConsumed;
      computeUnitLimit = Math.min(
        MAX_COMPUTE_UNITS,
        Math.max(MIN_COMPUTE_UNITS, Math.ceil(outcome.unitsConsumed * CU_SAFETY_MULTIPLIER)),
      );
    } else {
      warnings.push(`Simulasi dilewati (timeout/RPC sibuk); memakai CU limit default ${FALLBACK_COMPUTE_UNITS.toLocaleString("id-ID")}.`);
    }
  }

  // ---- 3. FINAL ASSEMBLE + SIGN ----
  report("signing", "Menandatangani dengan burner wallet…");
  const signStarted = performance.now();
  const computeUnitPriceMicroLamports = computeUnitPriceFromFee(settings.priorityFeeLamports, computeUnitLimit);
  const transaction = assembleSwapTransaction({
    build,
    payer: signer.publicKey,
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    tipLamports: settings.tipLamports,
    tipAccount,
    extraInstructions: plan.extraInstructions,
  });
  transaction.sign([signer]);
  const firstSignature = transaction.signatures[0];
  if (!firstSignature) {
    throw new SwapError("SEND_FAILED", "Transaksi tidak memiliki signature setelah ditandatangani.", { stage: "signing" });
  }
  const signature = bs58.encode(firstSignature);
  const rawTransaction = transaction.serialize();
  const base64Transaction = Buffer.from(rawTransaction).toString("base64");
  const signMs = Math.round(performance.now() - signStarted);
  touchWalletSession();

  // ---- 4. SEND PARALEL ----
  report("sending", `Mengirim (${settings.sendMode})…`, signature);
  const paths: SendPathResult[] = [];
  const sender = createSender(settings.sendMode, rawTransaction, base64Transaction, paths);
  const sendStarted = performance.now();
  try {
    await sender.initial();
  } catch (error) {
    throw new SwapError("SEND_FAILED", `Semua jalur pengiriman gagal: ${toError(error).message}`, {
      stage: "sending",
      signature,
    });
  }
  const firstSendMs = Math.round(performance.now() - sendStarted);

  // ---- 5. CONFIRM ----
  report("confirming", "Menunggu konfirmasi blok…", signature);
  const confirmStarted = performance.now();
  let confirmation: { slot: number; confirmationStatus: "confirmed" | "finalized" };
  try {
    confirmation = await confirmWithRebroadcast({
      signature,
      lastValidBlockHeight: build.blockhashWithMetadata.lastValidBlockHeight,
      rebroadcast: sender.rebroadcast,
    });
  } catch (error) {
    if (error instanceof SwapError && error.code === "TX_FAILED") {
      const logs = await fetchFailureLogs(signature);
      const failure = classifyFailure(error.transactionError, logs);
      throw new SwapError(failure.code, failure.message, {
        stage: "confirming",
        signature,
        logs,
        transactionError: error.transactionError,
      });
    }
    throw error;
  }
  const confirmMs = Math.round(performance.now() - confirmStarted);
  report("confirmed", "Transaksi confirmed ✓", signature);

  // ---- 6. JUMLAH AKTUAL ----
  const executed = await fetchExecutedAmounts({
    signature,
    owner: signer.publicKey,
    mint: plan.mint,
    decimals: tokenDecimals,
    tipLamports: settings.tipLamports,
  });
  if (!executed) {
    warnings.push("Detail transaksi belum tersedia dari RPC; jumlah aktual belum bisa dihitung.");
  }

  return {
    signature,
    side: plan.side,
    mint: plan.mint.toBase58(),
    tokenDecimals,
    sendMode: settings.sendMode,
    slot: confirmation.slot,
    confirmationStatus: confirmation.confirmationStatus,
    quote: {
      inputMint: build.inputMint,
      outputMint: build.outputMint,
      inAmountRaw: BigInt(build.inAmount),
      outAmountRaw: BigInt(build.outAmount),
      minOutAmountRaw: BigInt(build.otherAmountThreshold),
      priceImpactPct: Number(build.priceImpactPct) * 100,
      slippageBps: build.slippageBps,
      routeLabels: build.routePlan.map((step) => step.swapInfo.label),
    },
    executed,
    fees: {
      priorityFeeLamports: settings.priorityFeeLamports,
      computeUnitLimit,
      computeUnitsConsumed,
      computeUnitPriceMicroLamports,
      tipLamports: settings.tipLamports,
      tipAccount: tipAccount.toBase58(),
    },
    paths,
    timings: {
      buildMs,
      simulateMs,
      signMs,
      firstSendMs,
      confirmMs,
      totalMs: Date.now() - plan.startedAt,
    },
    warnings,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

function requireSigner(): Keypair {
  try {
    return getUnlockedKeypair();
  } catch (error) {
    if (error instanceof WalletError) {
      throw new SwapError("WALLET_LOCKED", error.message, { stage: "preparing" });
    }
    throw error;
  }
}

function lamportsLabel(lamports: bigint): string {
  return `${rawToUiAmount(lamports, SOL_DECIMALS).toLocaleString("id-ID", { maximumFractionDigits: 6 })} SOL`;
}

// ===========================================================================
// API publik: BUY & SELL
// ===========================================================================

export interface BuyParams {
  mint: PublicKey | string;
  /** Jumlah SOL yang dibelanjakan, mis. 0.05, "0.1", atau "0,5". */
  solAmount: number | string;
  settings?: Partial<SwapSettings>;
  onStatus?: (update: SwapStatusUpdate) => void;
}

/** BUY: SOL → token. */
export async function buyToken(params: BuyParams): Promise<SwapResult> {
  const startedAt = Date.now();
  params.onStatus?.({ stage: "preparing", message: "Menyiapkan pembelian…", elapsedMs: 0 });

  const signer = requireSigner();
  const settings = resolveSwapSettings(params.settings);

  let mint: PublicKey;
  let amountLamports: bigint;
  try {
    mint = toPublicKey(params.mint, "Contract Address");
    amountLamports = uiToRaw(params.solAmount, SOL_DECIMALS);
  } catch (error) {
    throw new SwapError("INVALID_INPUT", toError(error).message, { stage: "preparing" });
  }
  if (amountLamports <= 0n) {
    throw new SwapError("INVALID_INPUT", "Jumlah SOL harus lebih dari 0.", { stage: "preparing" });
  }
  if (mint.equals(WSOL_MINT)) {
    throw new SwapError("INVALID_INPUT", "Tidak bisa membeli SOL dengan SOL.", { stage: "preparing" });
  }

  const preflight = (async () => {
    const [balance, meta] = await Promise.all([
      getConnection().getBalance(signer.publicKey, "confirmed"),
      getMintMeta(mint).catch((error: unknown) => {
        if (error instanceof NotATokenMintError) {
          throw new SwapError("INVALID_INPUT", error.message, { stage: "preparing" });
        }
        throw error;
      }),
    ]);
    const required = amountLamports + settings.tipLamports + settings.priorityFeeLamports + BUY_SOL_RESERVE_LAMPORTS;
    if (BigInt(balance) < required) {
      throw new SwapError(
        "INSUFFICIENT_SOL",
        `Saldo ${lamportsLabel(BigInt(balance))}, butuh ±${lamportsLabel(required)} (jumlah + fee + tip + cadangan rent ${lamportsLabel(BUY_SOL_RESERVE_LAMPORTS)}).`,
        { stage: "preparing" },
      );
    }
    return { tokenDecimals: meta.decimals };
  })();
  preflight.catch(() => undefined);

  return executeSwap({
    side: "buy",
    mint,
    inputMint: WSOL_MINT,
    outputMint: mint,
    amountRaw: amountLamports,
    signer,
    settings,
    extraInstructions: [],
    preflight,
    onStatus: params.onStatus,
    startedAt,
  });
}

export interface SellParams {
  mint: PublicKey | string;
  /** Persentase saldo ATA yang dijual: 25, 50, 75, 100, atau angka custom 0–100. */
  percent: number;
  settings?: Partial<SwapSettings>;
  onStatus?: (update: SwapStatusUpdate) => void;
}

/** SELL: token → SOL, berdasarkan persentase saldo token di ATA. */
export async function sellToken(params: SellParams): Promise<SwapResult> {
  const startedAt = Date.now();
  params.onStatus?.({ stage: "preparing", message: "Membaca saldo token…", elapsedMs: 0 });

  const signer = requireSigner();
  const settings = resolveSwapSettings(params.settings);

  if (!Number.isFinite(params.percent) || params.percent <= 0 || params.percent > 100) {
    throw new SwapError("INVALID_INPUT", "Persentase jual harus di antara 0 dan 100.", { stage: "preparing" });
  }

  let mint: PublicKey;
  try {
    mint = toPublicKey(params.mint, "Contract Address");
  } catch (error) {
    throw new SwapError("INVALID_INPUT", toError(error).message, { stage: "preparing" });
  }

  const [tokenBalance, solBalance] = await Promise.all([
    getTokenBalance(signer.publicKey, mint).catch((error: unknown) => {
      if (error instanceof NotATokenMintError) {
        throw new SwapError("INVALID_INPUT", error.message, { stage: "preparing" });
      }
      throw error;
    }),
    getConnection().getBalance(signer.publicKey, "confirmed"),
  ]);

  if (tokenBalance.ataRaw === 0n) {
    throw new SwapError(
      "NO_TOKEN_BALANCE",
      tokenBalance.totalRaw > 0n
        ? "Token ada di akun non-ATA. Terminal hanya menjual dari Associated Token Account."
        : "Tidak ada saldo token ini di wallet.",
      { stage: "preparing" },
    );
  }

  const isFullSell = params.percent >= 100;
  const basisPoints = BigInt(Math.round(params.percent * 100));
  const amountRaw = isFullSell ? tokenBalance.ataRaw : (tokenBalance.ataRaw * basisPoints) / 10_000n;
  if (amountRaw <= 0n) {
    throw new SwapError("NO_TOKEN_BALANCE", "Jumlah jual terlalu kecil (0 unit token).", { stage: "preparing" });
  }

  const required = settings.tipLamports + settings.priorityFeeLamports + SELL_SOL_RESERVE_LAMPORTS;
  if (BigInt(solBalance) < required) {
    throw new SwapError(
      "INSUFFICIENT_SOL",
      `Saldo ${lamportsLabel(BigInt(solBalance))}, butuh ±${lamportsLabel(required)} untuk fee + tip + rent sementara WSOL.`,
      { stage: "preparing" },
    );
  }

  const extraInstructions: TransactionInstruction[] = [];
  const isClassicToken = tokenBalance.programId === TOKEN_PROGRAM_ID.toBase58();
  const ataIsOnlyAccount = tokenBalance.totalRaw === tokenBalance.ataRaw;
  if (isFullSell && settings.closeTokenAccountOnFullSell && isClassicToken && ataIsOnlyAccount) {
    const ata = getAssociatedTokenAddressSync(mint, signer.publicKey, true, TOKEN_PROGRAM_ID);
    extraInstructions.push(createCloseAccountInstruction(ata, signer.publicKey, signer.publicKey, [], TOKEN_PROGRAM_ID));
  }

  return executeSwap({
    side: "sell",
    mint,
    inputMint: mint,
    outputMint: WSOL_MINT,
    amountRaw,
    signer,
    settings,
    extraInstructions,
    preflight: Promise.resolve({ tokenDecimals: tokenBalance.decimals }),
    onStatus: params.onStatus,
    startedAt,
  });
}
