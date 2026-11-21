/**
 * src/lib/price-feed.ts — Satu sumber harga live untuk seluruh terminal.
 *
 * - Semua komponen/hook yang butuh harga cukup memanggil priceFeed.track([mint]).
 *   Mint dihitung dengan reference count, jadi tidak ada polling ganda.
 * - Setiap 2 detik: SATU request DexScreener untuk maksimal 30 mint sekaligus
 *   (endpoint /tokens/v1/solana/{a,b,c}). 30 mint = 30 req/menit, jauh di bawah
 *   batas ±300 req/menit.
 * - Harga SOL/USD diambil terpisah tiap 30 detik (untuk konversi USD ↔ SOL).
 * - Sengaja TIDAK memakai Jupiter Price API: kuota gratis Jupiter (1 req/detik)
 *   dipakai bersama /build — polling harga di sana akan membuat Buy/Sell kena 429.
 *
 * Batasan: data DexScreener bisa tertinggal beberapa detik dari on-chain.
 */

import { DEXSCREENER_API_URL, HttpError, WSOL_MINT, fetchJson, toError } from "./rpc";
import { normalizeDexScreenerPairs, type MarketData } from "./scanner";
import { subscribeHeartbeat } from "./heartbeat";

export const PRICE_POLL_INTERVAL_MS = 2_000;
const SOL_PRICE_INTERVAL_MS = 30_000;
const MAX_MINTS_PER_REQUEST = 30;
const MAX_TRACKED_MINTS = 90;

export interface PriceSnapshot {
  prices: Readonly<Record<string, MarketData>>;
  solUsd: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveErrors: number;
  /** Naik setiap selesai satu siklus polling (berhasil maupun gagal). */
  tick: number;
}

const EMPTY_SNAPSHOT: PriceSnapshot = {
  prices: {},
  solUsd: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveErrors: 0,
  tick: 0,
};

/** Harga dalam SOL: langsung dari pair SOL, atau konversi USD → SOL. */
export function getPriceSol(market: MarketData | null | undefined, solUsd: number | null): number | null {
  if (!market) return null;
  if (market.priceInSol !== null && market.priceInSol > 0) return market.priceInSol;
  if (market.priceUsd !== null && solUsd !== null && solUsd > 0) return market.priceUsd / solUsd;
  return null;
}

class PriceFeed {
  private trackedCounts = new Map<string, number>();
  private listeners = new Set<() => void>();
  private snapshot: PriceSnapshot = EMPTY_SNAPSHOT;
  private unsubscribeHeartbeat: (() => void) | null = null;
  private lastPollAt = 0;
  private lastSolPollAt = 0;
  private inFlight = false;
  private backoffUntil = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.ensureRunning();
    return () => {
      this.listeners.delete(listener);
      this.stopIfIdle();
    };
  };

  readonly getSnapshot = (): PriceSnapshot => this.snapshot;

  readonly getServerSnapshot = (): PriceSnapshot => EMPTY_SNAPSHOT;

  /** Mulai memantau mint. Return fungsi untuk berhenti memantau. */
  readonly track = (mints: readonly string[]): (() => void) => {
    const unique = [...new Set(mints.filter(Boolean))];
    let added = false;
    for (const mint of unique) {
      const count = this.trackedCounts.get(mint) ?? 0;
      if (count === 0) added = true;
      this.trackedCounts.set(mint, count + 1);
    }
    this.ensureRunning();
    if (added) this.lastPollAt = 0; // mint baru → ambil harga di detak berikutnya
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const mint of unique) {
        const count = (this.trackedCounts.get(mint) ?? 1) - 1;
        if (count <= 0) this.trackedCounts.delete(mint);
        else this.trackedCounts.set(mint, count);
      }
      this.stopIfIdle();
    };
  };

  /** Paksa polling di detak berikutnya (mis. setelah transaksi). */
  readonly refreshSoon = (): void => {
    this.lastPollAt = 0;
  };

  private ensureRunning(): void {
    if (this.unsubscribeHeartbeat || typeof window === "undefined") return;
    this.unsubscribeHeartbeat = subscribeHeartbeat((now) => void this.onHeartbeat(now));
  }

  private stopIfIdle(): void {
    if (this.listeners.size === 0 && this.trackedCounts.size === 0 && this.unsubscribeHeartbeat) {
      this.unsubscribeHeartbeat();
      this.unsubscribeHeartbeat = null;
    }
  }

  private setSnapshot(patch: Partial<PriceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[price-feed] listener error", error);
      }
    }
  }

  private async onHeartbeat(now: number): Promise<void> {
    if (this.inFlight || now < this.backoffUntil) return;
    const dueSol = now - this.lastSolPollAt >= SOL_PRICE_INTERVAL_MS;
    const dueMints = this.trackedCounts.size > 0 && now - this.lastPollAt >= PRICE_POLL_INTERVAL_MS;
    if (!dueSol && !dueMints) return;

    this.inFlight = true;
    try {
      if (dueSol) {
        this.lastSolPollAt = now;
        await this.pollSolPrice();
      }
      if (dueMints) {
        this.lastPollAt = now;
        await this.pollMints();
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async pollSolPrice(): Promise<void> {
    try {
      const payload = await fetchJson<unknown>(`${DEXSCREENER_API_URL}/tokens/v1/solana/${WSOL_MINT.toBase58()}`, {
        timeoutMs: 5_000,
        headers: { accept: "application/json" },
      });
      const market = normalizeDexScreenerPairs(WSOL_MINT.toBase58(), payload);
      if (market?.priceUsd) this.setSnapshot({ solUsd: market.priceUsd });
    } catch {
      this.lastSolPollAt = 0; // coba lagi di detak berikutnya
    }
  }

  private async pollMints(): Promise<void> {
    const mints = [...this.trackedCounts.keys()].slice(0, MAX_TRACKED_MINTS);
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += MAX_MINTS_PER_REQUEST) {
      chunks.push(mints.slice(i, i + MAX_MINTS_PER_REQUEST));
    }

    const results = await Promise.allSettled(
      chunks.map((chunk) =>
        fetchJson<unknown>(`${DEXSCREENER_API_URL}/tokens/v1/solana/${chunk.join(",")}`, {
          timeoutMs: 5_000,
          headers: { accept: "application/json" },
        }).then((payload) => ({ chunk, payload })),
      ),
    );

    const prices: Record<string, MarketData> = { ...this.snapshot.prices };
    const fetchedAt = Date.now();
    let anySuccess = false;
    let lastError: string | null = null;
    let rateLimited = false;

    for (const result of results) {
      if (result.status === "rejected") {
        const error = result.reason;
        if (error instanceof HttpError && error.status === 429) rateLimited = true;
        lastError = toError(error).message;
        continue;
      }
      anySuccess = true;
      for (const mint of result.value.chunk) {
        const market = normalizeDexScreenerPairs(mint, result.value.payload, fetchedAt);
        if (market) prices[mint] = market;
      }
    }

    // Buang harga mint yang sudah tidak dipantau agar snapshot tetap kecil.
    for (const mint of Object.keys(prices)) {
      if (!this.trackedCounts.has(mint)) delete prices[mint];
    }

    if (rateLimited) this.backoffUntil = Date.now() + 10_000;

    this.setSnapshot({
      prices,
      lastSuccessAt: anySuccess ? fetchedAt : this.snapshot.lastSuccessAt,
      lastError: anySuccess ? null : lastError ?? "Gagal mengambil harga",
      consecutiveErrors: anySuccess ? 0 : this.snapshot.consecutiveErrors + 1,
      tick: this.snapshot.tick + 1,
    });
  }
}

export const priceFeed = new PriceFeed();
