/**
 * src/lib/scanner.ts — DexScreener Scanner & On-Chain Token Security
 *
 * Cara kerja singkat:
 * 1. fetchMarketData(): ambil semua pair token dari DexScreener, pilih pair utama
 *    (likuiditas terbesar), lalu normalisasi harga, MC, FDV, likuiditas, volume,
 *    dan perubahan harga 5m/1h/6h/24h. Semua angka dari string API diubah ke number
 *    dengan aman (null bila tidak tersedia, bukan 0 palsu).
 * 2. checkMintSecurity(): baca akun mint langsung dari chain (bukan dari API pihak
 *    ketiga). Cek mintAuthority & freezeAuthority harus null. Untuk Token-2022,
 *    periksa juga ekstensi berbahaya (permanent delegate, transfer hook, transfer
 *    fee/pajak, default frozen, pausable, non-transferable).
 * 3. getTopHolders(): getTokenLargestAccounts mengembalikan 20 TOKEN ACCOUNT terbesar.
 *    Akun-akun ini dikelompokkan per OWNER (whale yang memecah saldo ke beberapa akun
 *    tetap terdeteksi), lalu diklasifikasi: pool/bonding curve DEX, alamat burn,
 *    PDA program tak dikenal, atau wallet biasa. Konsentrasi dihitung TANPA pool,
 *    karena bonding curve pump.fun / vault Raydium wajar memegang porsi besar.
 * 4. evaluateRisk(): gabungkan semua temuan menjadi daftar flag + level risiko.
 */

import { PublicKey, type AccountInfo } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  getDefaultAccountState,
  getExtensionTypes,
  getPausableConfig,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackAccount,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import {
  DEXSCREENER_API_URL,
  HttpError,
  NotATokenMintError,
  WSOL_MINT,
  fetchJson,
  getConnection,
  getMintMeta,
  rawToUiAmount,
  toError,
  toPublicKey,
} from "./rpc";

// ===========================================================================
// Ambang batas risiko (silakan disesuaikan dengan gaya trading Anda)
// ===========================================================================

export const RISK_THRESHOLDS = {
  /** Satu holder non-pool memegang lebih dari ini (%) → HIGH. */
  singleHolderHighPct: 10,
  /** Satu holder non-pool memegang lebih dari ini (%) → MEDIUM. */
  singleHolderMediumPct: 5,
  /** Top 10 holder non-pool lebih dari ini (%) → HIGH. */
  top10HighPct: 50,
  /** Top 10 holder non-pool lebih dari ini (%) → MEDIUM. */
  top10MediumPct: 30,
  /** Likuiditas di bawah ini (USD) → HIGH. Tidak berlaku untuk bonding curve. */
  liquidityHighUsd: 3_000,
  /** Likuiditas di bawah ini (USD) → MEDIUM. */
  liquidityMediumUsd: 10_000,
  /** Pajak transfer (Token-2022) di atas ini (bps) → HIGH. 500 bps = 5%. */
  transferFeeHighBps: 500,
} as const;

// ===========================================================================
// Program & alamat yang dikenal
// ===========================================================================

/** Program DEX/launchpad: akun yang dimiliki program ini = pool / bonding curve. */
const KNOWN_POOL_PROGRAMS: Readonly<Record<string, string>> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun Bonding Curve",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap AMM",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora DAMM v1",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora DBC",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
};

/** Authority PDA vault pool yang akunnya sendiri tidak punya data on-chain. */
const KNOWN_POOL_AUTHORITIES: Readonly<Record<string, string>> = {
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1": "Raydium AMM v4 Authority",
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: "Raydium CPMM Authority",
  WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh: "Raydium LaunchLab Authority",
  HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC: "Meteora DAMM v2 Authority",
  FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM: "Meteora DBC Authority",
};

const BURN_ADDRESSES: Readonly<Record<string, string>> = {
  "1nc1nerator11111111111111111111111111111111": "Incinerator (burn)",
};

/** dexId DexScreener untuk token yang masih di bonding curve. */
const BONDING_CURVE_DEX_IDS = new Set(["pumpfun", "launchlab", "meteora-dbc", "moonshot", "boop", "bonk"]);

// ===========================================================================
// Tipe umum
// ===========================================================================

export type Severity = "critical" | "high" | "medium" | "info";
export type RiskLevel = "danger" | "warning" | "caution" | "ok" | "unknown";

export interface RiskFlag {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

// ===========================================================================
// 1. DexScreener
// ===========================================================================

interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

interface DexScreenerWindow<T> {
  m5?: T;
  h1?: T;
  h6?: T;
  h24?: T;
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  labels?: string[];
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  priceNative?: string;
  priceUsd?: string;
  txns?: DexScreenerWindow<{ buys?: number; sells?: number }>;
  volume?: DexScreenerWindow<number>;
  priceChange?: DexScreenerWindow<number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    websites?: { url: string; label?: string }[];
    socials?: { type: string; url: string }[];
  };
}

export interface TimeWindowValues {
  m5: number | null;
  h1: number | null;
  h6: number | null;
  h24: number | null;
}

export interface TxnCounts {
  buys: number;
  sells: number;
}

export interface MarketData {
  mint: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  priceUsd: number | null;
  /** Harga dalam satuan quote token pair utama (mis. SOL). */
  priceNative: number | null;
  quoteSymbol: string;
  quoteMint: string;
  /** Terisi bila quote pair utama adalah SOL/WSOL. */
  priceInSol: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  liquidityQuote: number | null;
  volumeUsd: TimeWindowValues;
  priceChangePct: TimeWindowValues;
  txns: { m5: TxnCounts; h1: TxnCounts; h6: TxnCounts; h24: TxnCounts };
  dexId: string;
  pairAddress: string;
  pairUrl: string;
  pairCreatedAt: number | null;
  pairAgeMinutes: number | null;
  isBondingCurve: boolean;
  /** Ringkasan semua pair token ini. */
  pairCount: number;
  pairAddresses: string[];
  totalLiquidityUsd: number;
  totalVolume24hUsd: number;
  websites: string[];
  socials: { type: string; url: string }[];
  fetchedAt: number;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readWindow(source: DexScreenerWindow<number> | undefined): TimeWindowValues {
  return {
    m5: toNumberOrNull(source?.m5),
    h1: toNumberOrNull(source?.h1),
    h6: toNumberOrNull(source?.h6),
    h24: toNumberOrNull(source?.h24),
  };
}

function readTxns(source: { buys?: number; sells?: number } | undefined): TxnCounts {
  return { buys: toNumberOrNull(source?.buys) ?? 0, sells: toNumberOrNull(source?.sells) ?? 0 };
}

function isDexScreenerPair(value: unknown): value is DexScreenerPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as Record<string, unknown>;
  const base = pair.baseToken as Record<string, unknown> | undefined;
  const quote = pair.quoteToken as Record<string, unknown> | undefined;
  return (
    typeof pair.chainId === "string" &&
    typeof pair.dexId === "string" &&
    typeof pair.pairAddress === "string" &&
    typeof base?.address === "string" &&
    typeof quote?.address === "string"
  );
}

/**
 * Normalisasi respons DexScreener. Diekspor agar bisa diuji tanpa jaringan.
 * Mengembalikan null bila tidak ada pair Solana di mana token ini menjadi base token.
 */
export function normalizeDexScreenerPairs(mint: string, payload: unknown, now = Date.now()): MarketData | null {
  const rawPairs: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { pairs?: unknown }).pairs)
      ? ((payload as { pairs: unknown[] }).pairs)
      : [];

  const pairs = rawPairs
    .filter(isDexScreenerPair)
    .filter((pair) => pair.chainId === "solana" && pair.baseToken.address === mint);

  if (pairs.length === 0) return null;

  const sorted = [...pairs].sort((a, b) => {
    const liquidityDiff = (toNumberOrNull(b.liquidity?.usd) ?? 0) - (toNumberOrNull(a.liquidity?.usd) ?? 0);
    if (liquidityDiff !== 0) return liquidityDiff;
    return (toNumberOrNull(b.volume?.h24) ?? 0) - (toNumberOrNull(a.volume?.h24) ?? 0);
  });

  const main = sorted[0];
  if (!main) return null;

  const priceNative = toNumberOrNull(main.priceNative);
  const quoteIsSol = main.quoteToken.address === WSOL_MINT.toBase58();
  const pairCreatedAt = toNumberOrNull(main.pairCreatedAt);
  const dexId = main.dexId.toLowerCase();

  return {
    mint,
    name: main.baseToken.name,
    symbol: main.baseToken.symbol,
    imageUrl: main.info?.imageUrl ?? null,
    priceUsd: toNumberOrNull(main.priceUsd),
    priceNative,
    quoteSymbol: main.quoteToken.symbol,
    quoteMint: main.quoteToken.address,
    priceInSol: quoteIsSol ? priceNative : null,
    marketCapUsd: toNumberOrNull(main.marketCap),
    fdvUsd: toNumberOrNull(main.fdv),
    liquidityUsd: toNumberOrNull(main.liquidity?.usd),
    liquidityQuote: toNumberOrNull(main.liquidity?.quote),
    volumeUsd: readWindow(main.volume),
    priceChangePct: readWindow(main.priceChange),
    txns: {
      m5: readTxns(main.txns?.m5),
      h1: readTxns(main.txns?.h1),
      h6: readTxns(main.txns?.h6),
      h24: readTxns(main.txns?.h24),
    },
    dexId: main.dexId,
    pairAddress: main.pairAddress,
    pairUrl: main.url,
    pairCreatedAt,
    pairAgeMinutes: pairCreatedAt ? Math.max(0, Math.floor((now - pairCreatedAt) / 60_000)) : null,
    isBondingCurve: BONDING_CURVE_DEX_IDS.has(dexId),
    pairCount: pairs.length,
    pairAddresses: pairs.map((pair) => pair.pairAddress),
    totalLiquidityUsd: pairs.reduce((sum, pair) => sum + (toNumberOrNull(pair.liquidity?.usd) ?? 0), 0),
    totalVolume24hUsd: pairs.reduce((sum, pair) => sum + (toNumberOrNull(pair.volume?.h24) ?? 0), 0),
    websites: (main.info?.websites ?? []).map((site) => site.url).filter((url) => typeof url === "string"),
    socials: (main.info?.socials ?? []).filter(
      (social): social is { type: string; url: string } =>
        typeof social?.type === "string" && typeof social?.url === "string",
    ),
    fetchedAt: now,
  };
}

export class DexScreenerRateLimitError extends Error {
  constructor() {
    super("DexScreener membatasi request (HTTP 429). Perlambat interval refresh harga.");
    this.name = "DexScreenerRateLimitError";
  }
}

/** Ambil data market dari DexScreener. Null = token belum punya pair yang terindeks. */
export async function fetchMarketData(
  mint: PublicKey | string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MarketData | null> {
  const mintAddress = toPublicKey(mint, "Contract Address").toBase58();
  try {
    const payload = await fetchJson<unknown>(`${DEXSCREENER_API_URL}/tokens/v1/solana/${mintAddress}`, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 6_000,
      headers: { accept: "application/json" },
    });
    return normalizeDexScreenerPairs(mintAddress, payload);
  } catch (error) {
    if (error instanceof HttpError && error.status === 429) throw new DexScreenerRateLimitError();
    throw error;
  }
}

/**
 * Polling harga berkala. Mengembalikan fungsi stop.
 * Interval minimal 1.500 ms agar tidak melewati batas ±300 request/menit DexScreener.
 */
export function watchMarketData(
  mint: PublicKey | string,
  onUpdate: (data: MarketData | null) => void,
  options: { intervalMs?: number; onError?: (error: Error) => void } = {},
): () => void {
  const intervalMs = Math.max(1_500, options.intervalMs ?? Number(process.env.NEXT_PUBLIC_PRICE_REFRESH_MS ?? 3_000));
  let active = true;
  let inFlight: AbortController | null = null;

  const tick = async () => {
    if (inFlight) return; // jangan menumpuk request bila jaringan lambat
    inFlight = new AbortController();
    try {
      const data = await fetchMarketData(mint, { signal: inFlight.signal });
      if (active) onUpdate(data);
    } catch (error) {
      if (active) options.onError?.(toError(error));
    } finally {
      inFlight = null;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    active = false;
    clearInterval(timer);
    inFlight?.abort();
  };
}

// ===========================================================================
// 2. Keamanan mint on-chain
// ===========================================================================

export interface ExtensionFinding {
  extension: string;
  severity: Severity;
  detail: string;
}

export interface MintSecurityReport {
  mint: string;
  tokenProgram: "spl-token" | "token-2022";
  decimals: number;
  supplyRaw: bigint;
  supplyUi: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** true = tidak ada yang bisa mencetak token baru. */
  mintAuthorityRevoked: boolean;
  /** true = tidak ada yang bisa membekukan saldo Anda (anti-honeypot dasar). */
  freezeAuthorityRevoked: boolean;
  extensionTypes: string[];
  extensions: ExtensionFinding[];
  transferFeeBps: number;
  /** true bila kedua authority revoked dan tidak ada ekstensi critical/high. */
  passesBasicChecks: boolean;
  slot: number;
  checkedAt: number;
}

function isSetPubkey(value: PublicKey | null | undefined): value is PublicKey {
  return Boolean(value) && !(value as PublicKey).equals(PublicKey.default);
}

export async function checkMintSecurity(mint: PublicKey | string): Promise<MintSecurityReport> {
  const meta = await getMintMeta(mint, { forceRefresh: true });
  const account = meta.account;
  const findings: ExtensionFinding[] = [];
  const extensionTypes: string[] = [];
  let transferFeeBps = 0;

  if (meta.isToken2022) {
    const types = getExtensionTypes(account.tlvData);
    for (const type of types) {
      extensionTypes.push(ExtensionType[type] ?? `Unknown(${type})`);
      switch (type) {
        case ExtensionType.PermanentDelegate: {
          const config = getPermanentDelegate(account);
          if (isSetPubkey(config?.delegate)) {
            findings.push({
              extension: "PermanentDelegate",
              severity: "critical",
              detail: `Alamat ${config.delegate.toBase58()} bisa memindahkan atau membakar token dari wallet SIAPA PUN, termasuk Anda.`,
            });
          }
          break;
        }
        case ExtensionType.TransferHook: {
          const config = getTransferHook(account);
          if (isSetPubkey(config?.programId)) {
            findings.push({
              extension: "TransferHook",
              severity: "high",
              detail: `Setiap transfer menjalankan program ${config.programId.toBase58()} — program ini bisa memblokir penjualan (pola honeypot).`,
            });
          }
          break;
        }
        case ExtensionType.TransferFeeConfig: {
          const config = getTransferFeeConfig(account);
          if (config) {
            transferFeeBps = Math.max(
              config.newerTransferFee.transferFeeBasisPoints,
              config.olderTransferFee.transferFeeBasisPoints,
            );
            if (transferFeeBps > 0) {
              findings.push({
                extension: "TransferFeeConfig",
                severity: transferFeeBps > RISK_THRESHOLDS.transferFeeHighBps ? "high" : "medium",
                detail: `Pajak transfer ${(transferFeeBps / 100).toFixed(2)}% dipotong setiap beli/jual.`,
              });
            }
            if (isSetPubkey(config.transferFeeConfigAuthority)) {
              findings.push({
                extension: "TransferFeeConfig",
                severity: "high",
                detail: `Authority ${config.transferFeeConfigAuthority.toBase58()} masih bisa MENAIKKAN pajak transfer kapan saja.`,
              });
            }
          }
          break;
        }
        case ExtensionType.DefaultAccountState: {
          const config = getDefaultAccountState(account);
          if (config?.state === AccountState.Frozen) {
            findings.push({
              extension: "DefaultAccountState",
              severity: "critical",
              detail: "Token account baru otomatis BEKU. Anda bisa membeli tapi tidak bisa menjual sampai di-unfreeze.",
            });
          }
          break;
        }
        case ExtensionType.NonTransferable: {
          findings.push({
            extension: "NonTransferable",
            severity: "critical",
            detail: "Token tidak bisa dipindahkan sama sekali (soulbound) — tidak bisa dijual.",
          });
          break;
        }
        case ExtensionType.PausableConfig: {
          const config = getPausableConfig(account);
          if (config?.paused) {
            findings.push({
              extension: "PausableConfig",
              severity: "critical",
              detail: "Token sedang DI-PAUSE: semua transfer diblokir saat ini.",
            });
          } else if (isSetPubkey(config?.authority)) {
            findings.push({
              extension: "PausableConfig",
              severity: "high",
              detail: `Authority ${config.authority.toBase58()} bisa mem-pause semua transfer kapan saja.`,
            });
          }
          break;
        }
        case ExtensionType.MintCloseAuthority: {
          findings.push({
            extension: "MintCloseAuthority",
            severity: "medium",
            detail: "Ada authority yang bisa menutup akun mint (saat supply 0) dan membuat ulang mint di alamat yang sama.",
          });
          break;
        }
        case ExtensionType.ConfidentialTransferMint: {
          findings.push({
            extension: "ConfidentialTransferMint",
            severity: "medium",
            detail: "Transfer rahasia aktif: sebagian saldo/transfer tidak terlihat publik, analisis holder bisa tidak akurat.",
          });
          break;
        }
        case ExtensionType.ScaledUiAmountConfig: {
          findings.push({
            extension: "ScaledUiAmountConfig",
            severity: "medium",
            detail: "Jumlah yang ditampilkan wallet dikalikan multiplier yang bisa diubah — angka saldo bisa menyesatkan.",
          });
          break;
        }
        case ExtensionType.InterestBearingConfig: {
          findings.push({
            extension: "InterestBearingConfig",
            severity: "info",
            detail: "Token berbunga: jumlah tampilan berubah seiring waktu tanpa transaksi.",
          });
          break;
        }
        default:
          break;
      }
    }
  }

  const mintAuthorityRevoked = meta.mintAuthority === null;
  const freezeAuthorityRevoked = meta.freezeAuthority === null;
  const hasSevereExtension = findings.some((f) => f.severity === "critical" || f.severity === "high");

  return {
    mint: meta.mint.toBase58(),
    tokenProgram: meta.isToken2022 ? "token-2022" : "spl-token",
    decimals: meta.decimals,
    supplyRaw: meta.supplyRaw,
    supplyUi: rawToUiAmount(meta.supplyRaw, meta.decimals),
    mintAuthority: meta.mintAuthority?.toBase58() ?? null,
    freezeAuthority: meta.freezeAuthority?.toBase58() ?? null,
    mintAuthorityRevoked,
    freezeAuthorityRevoked,
    extensionTypes,
    extensions: findings,
    transferFeeBps,
    passesBasicChecks: mintAuthorityRevoked && freezeAuthorityRevoked && !hasSevereExtension,
    slot: meta.slot,
    checkedAt: Date.now(),
  };
}

// ===========================================================================
// 3. Top holders & konsentrasi whale
// ===========================================================================

export type HolderCategory = "wallet" | "liquidity-pool" | "burn" | "program-pda" | "unknown";

export interface HolderInfo {
  rank: number;
  owner: string;
  tokenAccounts: string[];
  amountRaw: bigint;
  uiAmount: number;
  percent: number;
  category: HolderCategory;
  label: string | null;
}

export interface HolderAnalysis {
  mint: string;
  supplyRaw: bigint;
  decimals: number;
  holders: HolderInfo[];
  /** Persentase top 10 owner termasuk pool (angka mentah, sering menyesatkan). */
  top10PercentAll: number;
  /** Persentase top 10 owner TANPA pool & burn — angka konsentrasi yang relevan. */
  top10PercentExcludingPools: number;
  largestNonPoolPercent: number;
  largestNonPool: HolderInfo | null;
  poolPercent: number;
  burnedPercent: number;
  /** getTokenLargestAccounts hanya melihat 20 token account teratas. */
  sampledAccounts: number;
  checkedAt: number;
}

export interface LargestAccountEntry {
  address: string;
  amountRaw: bigint;
}

export interface HolderClassificationInput {
  mint: string;
  supplyRaw: bigint;
  decimals: number;
  entries: LargestAccountEntry[];
  /** token account → owner wallet/PDA */
  ownerByTokenAccount: Map<string, string>;
  /** owner → program pemilik akun owner (null bila akun owner tidak ada on-chain) */
  ownerProgramByOwner: Map<string, string | null>;
  /** alamat pool dari DexScreener (pairAddress) */
  knownPoolAddresses: string[];
  limit: number;
}

function percentOf(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 0;
  // 4 digit desimal tanpa kehilangan presisi BigInt.
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

/** Klasifikasi murni (tanpa jaringan) — diekspor agar bisa diuji. */
export function classifyHolders(input: HolderClassificationInput): HolderAnalysis {
  const knownPools = new Set(input.knownPoolAddresses);
  const grouped = new Map<string, { amountRaw: bigint; tokenAccounts: string[] }>();

  for (const entry of input.entries) {
    if (entry.amountRaw <= 0n) continue;
    const owner = input.ownerByTokenAccount.get(entry.address) ?? `unknown:${entry.address}`;
    const existing = grouped.get(owner);
    if (existing) {
      existing.amountRaw += entry.amountRaw;
      existing.tokenAccounts.push(entry.address);
    } else {
      grouped.set(owner, { amountRaw: entry.amountRaw, tokenAccounts: [entry.address] });
    }
  }

  const classified: Omit<HolderInfo, "rank">[] = [...grouped.entries()].map(([owner, group]) => {
    let category: HolderCategory = "unknown";
    let label: string | null = null;

    if (owner.startsWith("unknown:")) {
      category = "unknown";
    } else if (BURN_ADDRESSES[owner]) {
      category = "burn";
      label = BURN_ADDRESSES[owner] ?? null;
    } else if (KNOWN_POOL_AUTHORITIES[owner]) {
      category = "liquidity-pool";
      label = KNOWN_POOL_AUTHORITIES[owner] ?? null;
    } else if (knownPools.has(owner) || group.tokenAccounts.some((account) => knownPools.has(account))) {
      category = "liquidity-pool";
      const programLabel = KNOWN_POOL_PROGRAMS[input.ownerProgramByOwner.get(owner) ?? ""];
      label = programLabel ?? "Pool DEX (DexScreener)";
    } else {
      const ownerProgram = input.ownerProgramByOwner.get(owner) ?? null;
      const programLabel = ownerProgram ? KNOWN_POOL_PROGRAMS[ownerProgram] : undefined;
      if (programLabel) {
        category = "liquidity-pool";
        label = programLabel;
      } else {
        let onCurve = true;
        try {
          onCurve = PublicKey.isOnCurve(new PublicKey(owner).toBytes());
        } catch {
          onCurve = true;
        }
        if (!onCurve) {
          category = "program-pda";
          label = ownerProgram ? `PDA milik program ${ownerProgram.slice(0, 4)}…${ownerProgram.slice(-4)}` : "PDA tak dikenal";
        } else {
          category = "wallet";
        }
      }
    }

    return {
      owner: owner.startsWith("unknown:") ? owner.slice("unknown:".length) : owner,
      tokenAccounts: group.tokenAccounts,
      amountRaw: group.amountRaw,
      uiAmount: rawToUiAmount(group.amountRaw, input.decimals),
      percent: percentOf(group.amountRaw, input.supplyRaw),
      category,
      label,
    };
  });

  classified.sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : b.amountRaw < a.amountRaw ? -1 : 0));
  const ranked: HolderInfo[] = classified.map((holder, index) => ({ ...holder, rank: index + 1 }));

  const isExcluded = (holder: HolderInfo) => holder.category === "liquidity-pool" || holder.category === "burn";
  const nonPool = ranked.filter((holder) => !isExcluded(holder));
  const sumPercent = (list: HolderInfo[]) =>
    percentOf(list.reduce((sum, holder) => sum + holder.amountRaw, 0n), input.supplyRaw);

  return {
    mint: input.mint,
    supplyRaw: input.supplyRaw,
    decimals: input.decimals,
    holders: ranked.slice(0, input.limit),
    top10PercentAll: sumPercent(ranked.slice(0, 10)),
    top10PercentExcludingPools: sumPercent(nonPool.slice(0, 10)),
    largestNonPoolPercent: nonPool[0]?.percent ?? 0,
    largestNonPool: nonPool[0] ?? null,
    poolPercent: sumPercent(ranked.filter((holder) => holder.category === "liquidity-pool")),
    burnedPercent: sumPercent(ranked.filter((holder) => holder.category === "burn")),
    sampledAccounts: input.entries.length,
    checkedAt: Date.now(),
  };
}

type LargestAccountsResponse = Awaited<ReturnType<ReturnType<typeof getConnection>["getTokenLargestAccounts"]>>;

export async function getTopHolders(
  mint: PublicKey | string,
  options: {
    limit?: number;
    supplyRaw?: bigint;
    decimals?: number;
    knownPoolAddresses?: string[];
    /** Request getTokenLargestAccounts yang sudah dimulai lebih dulu (paralel). */
    prefetchedLargest?: Promise<LargestAccountsResponse>;
  } = {},
): Promise<HolderAnalysis> {
  const connection = getConnection();
  const mintPk = toPublicKey(mint, "Contract Address");
  const limit = options.limit ?? 10;

  const [largest, meta] = await Promise.all([
    options.prefetchedLargest ?? connection.getTokenLargestAccounts(mintPk, "confirmed"),
    options.supplyRaw !== undefined && options.decimals !== undefined
      ? Promise.resolve(null)
      : getMintMeta(mintPk, { forceRefresh: true }),
  ]);

  const supplyRaw = options.supplyRaw ?? meta?.supplyRaw ?? 0n;
  const decimals = options.decimals ?? meta?.decimals ?? 0;
  const entries: LargestAccountEntry[] = largest.value.map((item) => ({
    address: item.address.toBase58(),
    amountRaw: BigInt(item.amount),
  }));

  // Token account → owner
  const tokenAccountKeys = largest.value.map((item) => item.address);
  const tokenAccountInfos = tokenAccountKeys.length
    ? await connection.getMultipleAccountsInfo(tokenAccountKeys, "confirmed")
    : [];
  const ownerByTokenAccount = new Map<string, string>();
  tokenAccountInfos.forEach((info: AccountInfo<Buffer> | null, index) => {
    const address = tokenAccountKeys[index];
    if (!info || !address) return;
    try {
      const account = unpackAccount(address, info, info.owner);
      ownerByTokenAccount.set(address.toBase58(), account.owner.toBase58());
    } catch {
      // bukan token account yang valid — biarkan sebagai unknown
    }
  });

  // Owner → program pemilik akun owner (untuk mendeteksi pool / bonding curve)
  const uniqueOwners = [...new Set(ownerByTokenAccount.values())];
  const ownerKeys = uniqueOwners.map((owner) => new PublicKey(owner));
  const ownerInfos = ownerKeys.length ? await connection.getMultipleAccountsInfo(ownerKeys, "confirmed") : [];
  const ownerProgramByOwner = new Map<string, string | null>();
  uniqueOwners.forEach((owner, index) => {
    ownerProgramByOwner.set(owner, ownerInfos[index]?.owner.toBase58() ?? null);
  });

  return classifyHolders({
    mint: mintPk.toBase58(),
    supplyRaw,
    decimals,
    entries,
    ownerByTokenAccount,
    ownerProgramByOwner,
    knownPoolAddresses: options.knownPoolAddresses ?? [],
    limit,
  });
}

// ===========================================================================
// 4. Evaluasi risiko gabungan
// ===========================================================================

export interface RiskAssessment {
  level: RiskLevel;
  label: string;
  flags: RiskFlag[];
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 3, high: 2, medium: 1, info: 0 };

export function evaluateRisk(input: {
  market: MarketData | null;
  security: MintSecurityReport | null;
  holders: HolderAnalysis | null;
}): RiskAssessment {
  const flags: RiskFlag[] = [];
  const { market, security, holders } = input;

  if (security) {
    if (!security.mintAuthorityRevoked) {
      flags.push({
        id: "mint-authority",
        severity: "high",
        title: "Mint authority AKTIF",
        detail: `${security.mintAuthority} bisa mencetak token baru tanpa batas dan menekan harga.`,
      });
    }
    if (!security.freezeAuthorityRevoked) {
      flags.push({
        id: "freeze-authority",
        severity: "critical",
        title: "Freeze authority AKTIF",
        detail: `${security.freezeAuthority} bisa membekukan token di wallet Anda sehingga tidak bisa dijual.`,
      });
    }
    for (const finding of security.extensions) {
      flags.push({
        id: `ext-${finding.extension}-${flags.length}`,
        severity: finding.severity,
        title: `Ekstensi Token-2022: ${finding.extension}`,
        detail: finding.detail,
      });
    }
  } else {
    flags.push({
      id: "security-unavailable",
      severity: "medium",
      title: "Cek on-chain gagal",
      detail: "Status mint/freeze authority belum terverifikasi. Jangan trading sebelum cek ini berhasil.",
    });
  }

  if (holders) {
    if (holders.sampledAccounts === 0) {
      flags.push({
        id: "holders-empty",
        severity: "medium",
        title: "Data holder kosong",
        detail: "RPC tidak mengembalikan daftar holder terbesar.",
      });
    }
    const largest = holders.largestNonPool;
    if (largest && holders.largestNonPoolPercent > RISK_THRESHOLDS.singleHolderMediumPct) {
      flags.push({
        id: "whale-single",
        severity: holders.largestNonPoolPercent > RISK_THRESHOLDS.singleHolderHighPct ? "high" : "medium",
        title: `Whale memegang ${holders.largestNonPoolPercent.toFixed(2)}%`,
        detail: `${largest.owner} (${largest.category === "program-pda" ? "PDA/program" : "wallet"}) memegang ${holders.largestNonPoolPercent.toFixed(2)}% supply.`,
      });
    }
    if (holders.top10PercentExcludingPools > RISK_THRESHOLDS.top10MediumPct) {
      flags.push({
        id: "whale-top10",
        severity: holders.top10PercentExcludingPools > RISK_THRESHOLDS.top10HighPct ? "high" : "medium",
        title: `Top 10 holder (tanpa pool) ${holders.top10PercentExcludingPools.toFixed(2)}%`,
        detail: "Konsentrasi tinggi: beberapa wallet bisa menjatuhkan harga sekaligus (dump).",
      });
    }
    const unknownPdas = holders.holders.filter((holder) => holder.category === "program-pda");
    if (unknownPdas.length > 0) {
      flags.push({
        id: "unknown-pda",
        severity: "info",
        title: `${unknownPdas.length} holder besar adalah PDA tak dikenal`,
        detail: "Bisa berupa locker/vesting, vault, atau pool DEX yang belum dikenali. Tetap dihitung sebagai konsentrasi.",
      });
    }
  } else {
    flags.push({
      id: "holders-unavailable",
      severity: "medium",
      title: "Analisis holder gagal",
      detail: "Konsentrasi whale belum terverifikasi.",
    });
  }

  if (market) {
    if (market.isBondingCurve) {
      flags.push({
        id: "bonding-curve",
        severity: "info",
        title: `Masih di bonding curve (${market.dexId})`,
        detail: "Harga bergerak sangat cepat; likuiditas DEX belum terbentuk.",
      });
    } else if (market.liquidityUsd !== null && market.liquidityUsd < RISK_THRESHOLDS.liquidityMediumUsd) {
      flags.push({
        id: "low-liquidity",
        severity: market.liquidityUsd < RISK_THRESHOLDS.liquidityHighUsd ? "high" : "medium",
        title: `Likuiditas rendah ($${Math.round(market.liquidityUsd).toLocaleString("en-US")})`,
        detail: "Slippage besar saat jual; mudah dimanipulasi.",
      });
    }
    if (market.pairAgeMinutes !== null && market.pairAgeMinutes < 15) {
      flags.push({
        id: "very-new",
        severity: "info",
        title: `Pair baru berumur ${market.pairAgeMinutes} menit`,
        detail: "Data holder & volume masih sangat cepat berubah.",
      });
    }
  } else {
    flags.push({
      id: "no-market",
      severity: "medium",
      title: "Tidak ada data DexScreener",
      detail: "Token belum terindeks atau belum punya pair. Harga & likuiditas tidak bisa diverifikasi.",
    });
  }

  flags.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  const worst = flags[0]?.severity;

  if (!security && !holders && !market) return { level: "unknown", label: "Tidak diketahui", flags };
  if (worst === "critical") return { level: "danger", label: "BAHAYA", flags };
  if (worst === "high") return { level: "warning", label: "RISIKO TINGGI", flags };
  if (worst === "medium") return { level: "caution", label: "WASPADA", flags };
  return { level: "ok", label: "Cek dasar lolos", flags };
}

// ===========================================================================
// 5. Scan lengkap satu CA
// ===========================================================================

export interface TokenScanResult {
  mint: string;
  market: MarketData | null;
  security: MintSecurityReport | null;
  holders: HolderAnalysis | null;
  risk: RiskAssessment;
  errors: { market?: string; security?: string; holders?: string };
  durationMs: number;
  scannedAt: number;
}

/**
 * Scan CA secara paralel: DexScreener, mint on-chain, dan getTokenLargestAccounts
 * dimulai bersamaan. Melempar NotATokenMintError bila alamat bukan mint token.
 */
export async function scanToken(mint: PublicKey | string, options: { holderLimit?: number } = {}): Promise<TokenScanResult> {
  const started = Date.now();
  const mintPk = toPublicKey(mint, "Contract Address");
  const mintAddress = mintPk.toBase58();
  const errors: TokenScanResult["errors"] = {};

  const largestPromise = getConnection().getTokenLargestAccounts(mintPk, "confirmed");
  largestPromise.catch(() => undefined); // cegah unhandled rejection; error ditangani di getTopHolders

  const [marketResult, securityResult] = await Promise.allSettled([
    fetchMarketData(mintAddress),
    checkMintSecurity(mintPk),
  ]);

  const market = marketResult.status === "fulfilled" ? marketResult.value : null;
  if (marketResult.status === "rejected") errors.market = toError(marketResult.reason).message;

  if (securityResult.status === "rejected" && securityResult.reason instanceof NotATokenMintError) {
    throw securityResult.reason;
  }
  const security = securityResult.status === "fulfilled" ? securityResult.value : null;
  if (securityResult.status === "rejected") errors.security = toError(securityResult.reason).message;

  let holders: HolderAnalysis | null = null;
  try {
    holders = await getTopHolders(mintPk, {
      limit: options.holderLimit ?? 10,
      supplyRaw: security?.supplyRaw,
      decimals: security?.decimals,
      knownPoolAddresses: market?.pairAddresses ?? [],
      prefetchedLargest: largestPromise,
    });
  } catch (error) {
    errors.holders = toError(error).message;
  }

  return {
    mint: mintAddress,
    market,
    security,
    holders,
    risk: evaluateRisk({ market, security, holders }),
    errors,
    durationMs: Date.now() - started,
    scannedAt: Date.now(),
  };
}
