/**
 * src/lib/wallet.ts — Burner Wallet & Security Manager
 *
 * Cara kerja singkat:
 * 1. Keypair dibuat/diimpor di browser, lalu secret key (64 byte) dienkripsi dengan
 *    AES-256-GCM. Kunci AES diturunkan dari password user memakai PBKDF2-SHA256
 *    600.000 iterasi + salt acak. Yang disimpan di localStorage HANYA ciphertext,
 *    salt, IV, dan public key (agar alamat bisa ditampilkan saat wallet terkunci).
 * 2. unlockWallet(password) mendekripsi sekali per sesi dan menyimpan Keypair di
 *    memori (variabel modul). Tombol Buy/Sell memakai getUnlockedKeypair() untuk
 *    menandatangani transaksi seketika — tanpa pop-up.
 * 3. lockWallet() / auto-lock membuang Keypair dari memori.
 * 4. Fungsi saldo: getSolBalance / getTokenBalance untuk sekali baca, serta
 *    watchSolBalance / watchTokenBalance untuk update real-time via WebSocket
 *    Helius (accountSubscribe) dengan polling cadangan bila WebSocket putus.
 *
 * Batasan keamanan yang jujur:
 * - Enkripsi melindungi dari pencurian isi localStorage (mis. ekstensi jahat yang
 *   membaca storage, backup browser, orang lain yang memakai komputer Anda).
 * - Enkripsi TIDAK melindungi saat wallet sedang terbuka: script jahat di halaman
 *   (XSS) bisa memakai Keypair di memori. Isi burner wallet secukupnya saja.
 */

import { Keypair, PublicKey, type AccountInfo, type ParsedAccountData } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { getConnection, getMintMeta, lamportsToSol, rawToUiAmount, toError, toPublicKey } from "./rpc";

// ===========================================================================
// Konstanta
// ===========================================================================

const STORAGE_KEY = "smt:burner-wallet:v1";
const RECORD_VERSION = 1 as const;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export const MIN_PASSWORD_LENGTH = 8;

// ===========================================================================
// Tipe & error
// ===========================================================================

export type WalletErrorCode =
  | "NOT_IN_BROWSER"
  | "CRYPTO_UNAVAILABLE"
  | "NO_WALLET"
  | "WALLET_EXISTS"
  | "WALLET_LOCKED"
  | "WRONG_PASSWORD"
  | "WEAK_PASSWORD"
  | "INVALID_SECRET_KEY"
  | "CORRUPTED_STORAGE";

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(message: string, code: WalletErrorCode) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

export interface EncryptedWalletRecord {
  version: typeof RECORD_VERSION;
  publicKey: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
}

export type WalletStatus = "none" | "locked" | "unlocked";

export interface WalletState {
  status: WalletStatus;
  publicKey: string | null;
  unlockedAt: number | null;
}

export type PasswordStrength = "lemah" | "sedang" | "kuat";

// ===========================================================================
// Util: browser, storage, base64, Web Crypto
// ===========================================================================

function getStorage(): Storage {
  if (typeof window === "undefined" || !window.localStorage) {
    throw new WalletError("Fitur wallet hanya bisa dipakai di browser.", "NOT_IN_BROWSER");
  }
  return window.localStorage;
}

function getSubtle(): SubtleCrypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") {
    throw new WalletError(
      "Web Crypto API tidak tersedia. Buka terminal lewat HTTPS atau http://localhost.",
      "CRYPTO_UNAVAILABLE",
    );
  }
  return cryptoApi.subtle;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  getSubtle();
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64");
  const output = new Uint8Array(decoded.length);
  output.set(decoded);
  return output;
}

function buildAdditionalData(publicKey: string, version: number): Uint8Array<ArrayBuffer> {
  // AAD mengikat ciphertext ke public key & versi: bila salah satu ditukar, dekripsi gagal.
  const encoded = new TextEncoder().encode(`smt-burner-wallet|v${version}|${publicKey}`);
  const output = new Uint8Array(encoded.length);
  output.set(encoded);
  return output;
}

async function deriveAesKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const subtle = getSubtle();
  const encodedPassword = new TextEncoder().encode(password.normalize("NFKC"));
  const passwordBytes = new Uint8Array(encodedPassword.length);
  passwordBytes.set(encodedPassword);

  const baseKey = await subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveKey"]);
  passwordBytes.fill(0);

  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ===========================================================================
// Password
// ===========================================================================

export function assessPasswordStrength(password: string): PasswordStrength {
  const length = password.length;
  const variety =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/\d/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));

  if (length >= 14 && variety >= 3) return "kuat";
  if (length >= 12 && variety >= 2) return "sedang";
  if (length >= 16) return "sedang";
  return "lemah";
}

export function validatePassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new WalletError(
      `Password minimal ${MIN_PASSWORD_LENGTH} karakter. PIN pendek bisa ditebak dalam hitungan menit bila data terenkripsi dicuri.`,
      "WEAK_PASSWORD",
    );
  }
}

// ===========================================================================
// Generate & import keypair
// ===========================================================================

export function generateKeypair(): Keypair {
  return Keypair.generate();
}

/**
 * Terima private key dalam format:
 * - Base58 64 byte (format export Phantom / Solflare / Backpack)
 * - Array JSON 64 angka, mis. [12,34,...] (format file Solana CLI id.json)
 *
 * Input 32 byte SENGAJA ditolak: alamat publik juga 32 byte Base58. Bila alamat
 * publik tertukar dipakai sebagai seed, terminal akan membuat wallet yang private
 * key-nya bisa diturunkan siapa pun yang tahu alamat Anda.
 */
export function keypairFromSecretInput(input: string): Keypair {
  const cleaned = input.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!cleaned) {
    throw new WalletError("Private key kosong.", "INVALID_SECRET_KEY");
  }

  let bytes: Uint8Array;
  if (cleaned.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new WalletError("Format array JSON tidak valid.", "INVALID_SECRET_KEY");
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)
    ) {
      throw new WalletError("Array private key harus berisi angka 0–255.", "INVALID_SECRET_KEY");
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = bs58.decode(cleaned);
    } catch {
      throw new WalletError("Private key bukan Base58 yang valid.", "INVALID_SECRET_KEY");
    }
  }

  if (bytes.length === 32) {
    throw new WalletError(
      "Ini terlihat seperti ALAMAT PUBLIK (32 byte), bukan private key. Private key Solana berukuran 64 byte.",
      "INVALID_SECRET_KEY",
    );
  }
  if (bytes.length !== 64) {
    throw new WalletError(
      `Panjang private key ${bytes.length} byte, seharusnya 64 byte.`,
      "INVALID_SECRET_KEY",
    );
  }

  try {
    // fromSecretKey memvalidasi bahwa 32 byte terakhir benar-benar public key dari 32 byte pertama.
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new WalletError(
      "Private key tidak valid: public key di dalamnya tidak cocok dengan secret key.",
      "INVALID_SECRET_KEY",
    );
  }
}

// ===========================================================================
// Enkripsi & dekripsi record
// ===========================================================================

export async function encryptKeypair(keypair: Keypair, password: string): Promise<EncryptedWalletRecord> {
  validatePassword(password);
  const subtle = getSubtle();
  const publicKey = keypair.publicKey.toBase58();
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveAesKey(password, salt, PBKDF2_ITERATIONS);

  const plaintext = new Uint8Array(64);
  plaintext.set(keypair.secretKey);

  try {
    const ciphertext = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: buildAdditionalData(publicKey, RECORD_VERSION) },
      key,
      plaintext,
    );
    const now = Date.now();
    return {
      version: RECORD_VERSION,
      publicKey,
      kdf: "PBKDF2-SHA256",
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      createdAt: now,
      updatedAt: now,
    };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptRecord(record: EncryptedWalletRecord, password: string): Promise<Keypair> {
  const subtle = getSubtle();
  const key = await deriveAesKey(password, base64ToBytes(record.salt), record.iterations);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(record.iv),
        additionalData: buildAdditionalData(record.publicKey, record.version),
      },
      key,
      base64ToBytes(record.ciphertext),
    );
  } catch {
    throw new WalletError("Password salah, atau data wallet di browser ini rusak.", "WRONG_PASSWORD");
  }

  const secretKey = new Uint8Array(plaintext);
  if (secretKey.length !== 64) {
    throw new WalletError("Data wallet rusak (panjang secret key tidak 64 byte).", "CORRUPTED_STORAGE");
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(secretKey);
  } catch {
    throw new WalletError("Data wallet rusak (secret key tidak valid).", "CORRUPTED_STORAGE");
  }

  if (keypair.publicKey.toBase58() !== record.publicKey) {
    throw new WalletError("Data wallet rusak (public key tidak cocok).", "CORRUPTED_STORAGE");
  }
  return keypair;
}

function isEncryptedWalletRecord(value: unknown): value is EncryptedWalletRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === RECORD_VERSION &&
    record.kdf === "PBKDF2-SHA256" &&
    typeof record.publicKey === "string" &&
    typeof record.iterations === "number" &&
    record.iterations >= 100_000 &&
    typeof record.salt === "string" &&
    typeof record.iv === "string" &&
    typeof record.ciphertext === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number"
  );
}

// ===========================================================================
// Penyimpanan localStorage
// ===========================================================================

export function getStoredWalletRecord(): EncryptedWalletRecord | null {
  const raw = getStorage().getItem(STORAGE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WalletError("Data wallet di localStorage rusak (bukan JSON).", "CORRUPTED_STORAGE");
  }
  if (!isEncryptedWalletRecord(parsed)) {
    throw new WalletError("Data wallet di localStorage rusak atau versinya tidak dikenal.", "CORRUPTED_STORAGE");
  }
  return parsed;
}

export function hasStoredWallet(): boolean {
  try {
    return getStoredWalletRecord() !== null;
  } catch (error) {
    if (error instanceof WalletError && error.code === "CORRUPTED_STORAGE") return true;
    return false;
  }
}

/** Alamat wallet tersimpan (tetap bisa dibaca saat wallet terkunci). */
export function getStoredPublicKey(): string | null {
  try {
    return getStoredWalletRecord()?.publicKey ?? null;
  } catch {
    return null;
  }
}

function writeRecord(record: EncryptedWalletRecord): void {
  getStorage().setItem(STORAGE_KEY, JSON.stringify(record));
}

async function storeKeypair(
  keypair: Keypair,
  password: string,
  options: { overwrite?: boolean } = {},
): Promise<EncryptedWalletRecord> {
  validatePassword(password);
  const existing = getStoredWalletRecord();
  if (existing && !options.overwrite && existing.publicKey !== keypair.publicKey.toBase58()) {
    throw new WalletError(
      `Sudah ada wallet tersimpan (${existing.publicKey}). Hapus atau ekspor dulu, atau gunakan overwrite.`,
      "WALLET_EXISTS",
    );
  }
  const record = await encryptKeypair(keypair, password);
  writeRecord(record);
  setSession(keypair);
  return record;
}

/**
 * Buat wallet baru, simpan terenkripsi, dan langsung buka sesi.
 * `secretKeyBase58` dikembalikan SATU KALI agar UI bisa menampilkan backup —
 * jangan simpan nilai ini di state global.
 */
export async function createAndStoreWallet(
  password: string,
  options: { overwrite?: boolean } = {},
): Promise<{ publicKey: string; secretKeyBase58: string }> {
  const keypair = generateKeypair();
  await storeKeypair(keypair, password, options);
  return { publicKey: keypair.publicKey.toBase58(), secretKeyBase58: bs58.encode(keypair.secretKey) };
}

export async function importAndStoreWallet(
  secretInput: string,
  password: string,
  options: { overwrite?: boolean } = {},
): Promise<{ publicKey: string }> {
  const keypair = keypairFromSecretInput(secretInput);
  await storeKeypair(keypair, password, options);
  return { publicKey: keypair.publicKey.toBase58() };
}

export async function changeWalletPassword(currentPassword: string, newPassword: string): Promise<void> {
  validatePassword(newPassword);
  const record = getStoredWalletRecord();
  if (!record) throw new WalletError("Belum ada wallet tersimpan.", "NO_WALLET");
  const keypair = await decryptRecord(record, currentPassword);
  const updated = await encryptKeypair(keypair, newPassword);
  writeRecord({ ...updated, createdAt: record.createdAt });
  setSession(keypair);
}

/** Minta password lagi sebelum menampilkan private key (untuk backup). */
export async function exportSecretKeyBase58(password: string): Promise<string> {
  const record = getStoredWalletRecord();
  if (!record) throw new WalletError("Belum ada wallet tersimpan.", "NO_WALLET");
  const keypair = await decryptRecord(record, password);
  return bs58.encode(keypair.secretKey);
}

/** Hapus wallet dari browser ini. Pastikan private key sudah di-backup! */
export function deleteStoredWallet(): void {
  getStorage().removeItem(STORAGE_KEY);
  clearSession();
}

// ===========================================================================
// Sesi (Keypair di memori) + auto-lock
// ===========================================================================

let session: { keypair: Keypair; unlockedAt: number } | null = null;
const stateListeners = new Set<(state: WalletState) => void>();

let autoLockMs: number | null = null;
let autoLockTimer: ReturnType<typeof setTimeout> | null = null;
let browserListenersAttached = false;

export function getWalletState(): WalletState {
  if (session) {
    return {
      status: "unlocked",
      publicKey: session.keypair.publicKey.toBase58(),
      unlockedAt: session.unlockedAt,
    };
  }
  const publicKey = typeof window === "undefined" ? null : getStoredPublicKey();
  return { status: publicKey ? "locked" : "none", publicKey, unlockedAt: null };
}

function emitState(): void {
  const state = getWalletState();
  for (const listener of stateListeners) {
    try {
      listener(state);
    } catch (error) {
      console.error("[wallet] listener error", error);
    }
  }
}

function setSession(keypair: Keypair): void {
  session = { keypair, unlockedAt: Date.now() };
  attachBrowserListeners();
  touchWalletSession();
  emitState();
}

function clearSession(): void {
  session = null;
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  emitState();
}

export function onWalletStateChange(listener: (state: WalletState) => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

export async function unlockWallet(password: string): Promise<PublicKey> {
  const record = getStoredWalletRecord();
  if (!record) throw new WalletError("Belum ada wallet tersimpan.", "NO_WALLET");
  const keypair = await decryptRecord(record, password);
  setSession(keypair);
  return keypair.publicKey;
}

export function lockWallet(): void {
  clearSession();
}

export function isWalletUnlocked(): boolean {
  return session !== null;
}

/** Dipakai swap.ts untuk menandatangani transaksi seketika. */
export function getUnlockedKeypair(): Keypair {
  if (!session) {
    throw new WalletError("Wallet terkunci. Masukkan password untuk membuka.", "WALLET_LOCKED");
  }
  touchWalletSession();
  return session.keypair;
}

export function getUnlockedPublicKey(): PublicKey | null {
  return session?.keypair.publicKey ?? null;
}

/**
 * Kunci otomatis setelah tidak ada aktivitas selama `minutes`.
 * null / 0 = nonaktif. Aktivitas = klik/ketik di halaman atau setiap transaksi.
 */
export function configureAutoLock(minutes: number | null): void {
  autoLockMs = minutes && minutes > 0 ? Math.round(minutes * 60_000) : null;
  attachBrowserListeners();
  touchWalletSession();
}

export function touchWalletSession(): void {
  if (autoLockTimer) {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }
  if (!session || autoLockMs === null) return;
  autoLockTimer = setTimeout(() => lockWallet(), autoLockMs);
}

function attachBrowserListeners(): void {
  if (browserListenersAttached || typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return;
  }
  browserListenersAttached = true;

  let lastTouch = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastTouch < 5_000) return;
    lastTouch = now;
    touchWalletSession();
  };
  window.addEventListener("pointerdown", onActivity, { passive: true });
  window.addEventListener("keydown", onActivity, { passive: true });

  // Bila wallet dihapus/diganti dari tab lain, kunci sesi di tab ini.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    if (!session) {
      emitState();
      return;
    }
    const current = event.newValue ? getStoredPublicKey() : null;
    if (current !== session.keypair.publicKey.toBase58()) {
      clearSession();
    }
  });
}

// ===========================================================================
// Saldo SOL
// ===========================================================================

export interface SolBalance {
  owner: string;
  lamports: number;
  sol: number;
  slot: number;
  source: "rpc" | "websocket";
  updatedAt: number;
}

export async function getSolBalance(owner: PublicKey | string): Promise<SolBalance> {
  const ownerPk = toPublicKey(owner, "Alamat wallet");
  const { value, context } = await getConnection().getBalanceAndContext(ownerPk, "confirmed");
  return {
    owner: ownerPk.toBase58(),
    lamports: value,
    sol: lamportsToSol(value),
    slot: context.slot,
    source: "rpc",
    updatedAt: Date.now(),
  };
}

export interface WatchOptions {
  /** Polling cadangan bila WebSocket putus/terlambat. Default 15 detik. */
  pollIntervalMs?: number;
  onError?: (error: Error) => void;
}

/**
 * Update saldo SOL real-time. Update dengan slot lebih lama dari yang sudah
 * diterima diabaikan, sehingga hasil polling yang terlambat tidak menimpa
 * notifikasi WebSocket yang lebih baru.
 */
export function watchSolBalance(
  owner: PublicKey | string,
  onUpdate: (balance: SolBalance) => void,
  options: WatchOptions = {},
): () => void {
  const ownerPk = toPublicKey(owner, "Alamat wallet");
  const connection = getConnection();
  const pollMs = options.pollIntervalMs ?? 15_000;
  let active = true;
  let lastSlot = -1;

  const emit = (lamports: number, slot: number, source: SolBalance["source"]) => {
    if (!active || slot < lastSlot) return;
    lastSlot = slot;
    onUpdate({
      owner: ownerPk.toBase58(),
      lamports,
      sol: lamportsToSol(lamports),
      slot,
      source,
      updatedAt: Date.now(),
    });
  };

  const refresh = async () => {
    try {
      const { value, context } = await connection.getBalanceAndContext(ownerPk, "confirmed");
      emit(value, context.slot, "rpc");
    } catch (error) {
      if (active) options.onError?.(toError(error));
    }
  };

  void refresh();

  let subscriptionId: number | null = null;
  try {
    subscriptionId = connection.onAccountChange(
      ownerPk,
      (info, context) => emit(info.lamports, context.slot, "websocket"),
      { commitment: "confirmed" },
    );
  } catch (error) {
    options.onError?.(toError(error));
  }

  const timer = setInterval(() => void refresh(), pollMs);

  return () => {
    active = false;
    clearInterval(timer);
    if (subscriptionId !== null) {
      void connection.removeAccountChangeListener(subscriptionId).catch(() => undefined);
    }
  };
}

// ===========================================================================
// Saldo SPL Token
// ===========================================================================

export interface TokenAccountBalance {
  address: string;
  raw: bigint;
  isAssociated: boolean;
}

export interface TokenBalance {
  owner: string;
  mint: string;
  programId: string;
  isToken2022: boolean;
  decimals: number;
  /** Alamat Associated Token Account (ATA) — akun default yang dipakai Jupiter untuk jual. */
  ata: string;
  ataRaw: bigint;
  ataUiAmount: number;
  /** Total dari SEMUA token account milik owner untuk mint ini. */
  totalRaw: bigint;
  uiAmount: number;
  accounts: TokenAccountBalance[];
  slot: number;
  source: "rpc" | "websocket";
  updatedAt: number;
}

interface ParsedTokenAccountInfo {
  mint: string;
  owner: string;
  amount: bigint;
  decimals: number;
}

function readParsedTokenAccount(data: ParsedAccountData): ParsedTokenAccountInfo | null {
  const parsed = data.parsed as
    | { info?: { mint?: unknown; owner?: unknown; tokenAmount?: { amount?: unknown; decimals?: unknown } } }
    | undefined;
  const info = parsed?.info;
  const amount = info?.tokenAmount?.amount;
  const decimals = info?.tokenAmount?.decimals;
  if (
    !info ||
    typeof info.mint !== "string" ||
    typeof info.owner !== "string" ||
    typeof amount !== "string" ||
    typeof decimals !== "number"
  ) {
    return null;
  }
  return { mint: info.mint, owner: info.owner, amount: BigInt(amount), decimals };
}

export async function getTokenBalance(owner: PublicKey | string, mint: PublicKey | string): Promise<TokenBalance> {
  const ownerPk = toPublicKey(owner, "Alamat wallet");
  const meta = await getMintMeta(mint);
  const ata = getAssociatedTokenAddressSync(meta.mint, ownerPk, true, meta.programId);

  const { value, context } = await getConnection().getParsedTokenAccountsByOwner(
    ownerPk,
    { mint: meta.mint },
    "confirmed",
  );

  const accounts: TokenAccountBalance[] = [];
  let totalRaw = 0n;
  let ataRaw = 0n;
  for (const item of value) {
    const parsed = readParsedTokenAccount(item.account.data);
    if (!parsed || parsed.mint !== meta.mint.toBase58()) continue;
    const isAssociated = item.pubkey.equals(ata);
    accounts.push({ address: item.pubkey.toBase58(), raw: parsed.amount, isAssociated });
    totalRaw += parsed.amount;
    if (isAssociated) ataRaw = parsed.amount;
  }

  return {
    owner: ownerPk.toBase58(),
    mint: meta.mint.toBase58(),
    programId: meta.programId.toBase58(),
    isToken2022: meta.isToken2022,
    decimals: meta.decimals,
    ata: ata.toBase58(),
    ataRaw,
    ataUiAmount: rawToUiAmount(ataRaw, meta.decimals),
    totalRaw,
    uiAmount: rawToUiAmount(totalRaw, meta.decimals),
    accounts,
    slot: context.slot,
    source: "rpc",
    updatedAt: Date.now(),
  };
}

function readTokenAmountFromAccountInfo(
  address: PublicKey,
  info: AccountInfo<Buffer>,
  programId: PublicKey,
): bigint {
  if (info.lamports === 0 || info.data.length === 0) return 0n; // akun ditutup
  try {
    return unpackAccount(address, info, programId).amount;
  } catch {
    return 0n;
  }
}

/**
 * Update saldo token real-time. WebSocket berlangganan ke ATA (alamat ATA bisa
 * dihitung walau akunnya belum ada — notifikasi tetap datang saat ATA dibuat
 * ketika Anda membeli). Polling cadangan juga menangkap token di akun non-ATA.
 */
export function watchTokenBalance(
  owner: PublicKey | string,
  mint: PublicKey | string,
  onUpdate: (balance: TokenBalance) => void,
  options: WatchOptions = {},
): () => void {
  const ownerPk = toPublicKey(owner, "Alamat wallet");
  const connection = getConnection();
  const pollMs = options.pollIntervalMs ?? 15_000;
  let active = true;
  let lastSlot = -1;
  let latest: TokenBalance | null = null;
  let subscriptionId: number | null = null;

  const emit = (balance: TokenBalance) => {
    if (!active || balance.slot < lastSlot) return;
    lastSlot = balance.slot;
    latest = balance;
    onUpdate(balance);
  };

  const refresh = async () => {
    try {
      emit(await getTokenBalance(ownerPk, mint));
    } catch (error) {
      if (active) options.onError?.(toError(error));
    }
  };

  const timer = setInterval(() => void refresh(), pollMs);

  void (async () => {
    try {
      const meta = await getMintMeta(mint);
      if (!active) return;
      const ata = getAssociatedTokenAddressSync(meta.mint, ownerPk, true, meta.programId);

      subscriptionId = connection.onAccountChange(
        ata,
        (info, context) => {
          if (!latest) {
            void refresh();
            return;
          }
          const ataRaw = readTokenAmountFromAccountInfo(ata, info, meta.programId);
          const otherAccountsRaw = latest.totalRaw - latest.ataRaw;
          const totalRaw = otherAccountsRaw + ataRaw;
          const ataAddress = ata.toBase58();
          const hasAtaEntry = latest.accounts.some((account) => account.address === ataAddress);
          const accounts: TokenAccountBalance[] = hasAtaEntry
            ? latest.accounts.map((account) => (account.address === ataAddress ? { ...account, raw: ataRaw } : account))
            : [...latest.accounts, { address: ataAddress, raw: ataRaw, isAssociated: true }];

          emit({
            ...latest,
            ataRaw,
            ataUiAmount: rawToUiAmount(ataRaw, meta.decimals),
            totalRaw,
            uiAmount: rawToUiAmount(totalRaw, meta.decimals),
            accounts,
            slot: context.slot,
            source: "websocket",
            updatedAt: Date.now(),
          });
        },
        { commitment: "confirmed" },
      );

      if (!active && subscriptionId !== null) {
        void connection.removeAccountChangeListener(subscriptionId).catch(() => undefined);
        subscriptionId = null;
      }
    } catch (error) {
      if (active) options.onError?.(toError(error));
    }
    await refresh();
  })();

  return () => {
    active = false;
    clearInterval(timer);
    if (subscriptionId !== null) {
      void connection.removeAccountChangeListener(subscriptionId).catch(() => undefined);
      subscriptionId = null;
    }
  };
}

// ===========================================================================
// Semua token yang dipegang (untuk Position Tracker di tahap berikutnya)
// ===========================================================================

export interface TokenHolding {
  mint: string;
  programId: string;
  decimals: number;
  totalRaw: bigint;
  uiAmount: number;
  accounts: string[];
}

export async function getAllTokenHoldings(owner: PublicKey | string): Promise<TokenHolding[]> {
  const ownerPk = toPublicKey(owner, "Alamat wallet");
  const connection = getConnection();
  const [classic, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
    connection.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
  ]);

  const holdings = new Map<string, TokenHolding>();
  const collect = (items: typeof classic.value, programId: PublicKey) => {
    for (const item of items) {
      const parsed = readParsedTokenAccount(item.account.data);
      if (!parsed || parsed.amount === 0n) continue;
      const existing = holdings.get(parsed.mint);
      if (existing) {
        existing.totalRaw += parsed.amount;
        existing.uiAmount = rawToUiAmount(existing.totalRaw, existing.decimals);
        existing.accounts.push(item.pubkey.toBase58());
      } else {
        holdings.set(parsed.mint, {
          mint: parsed.mint,
          programId: programId.toBase58(),
          decimals: parsed.decimals,
          totalRaw: parsed.amount,
          uiAmount: rawToUiAmount(parsed.amount, parsed.decimals),
          accounts: [item.pubkey.toBase58()],
        });
      }
    }
  };
  collect(classic.value, TOKEN_PROGRAM_ID);
  collect(token2022.value, TOKEN_2022_PROGRAM_ID);

  return [...holdings.values()].sort((a, b) => b.uiAmount - a.uiAmount);
}
