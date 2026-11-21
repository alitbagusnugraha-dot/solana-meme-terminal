/**
 * next.config.mjs — Solana Meme Terminal
 *
 * Kompatibel dengan Next.js 16 (Turbopack default untuk dev & build).
 * Sengaja TIDAK memakai kustomisasi `webpack` agar `next build` (Turbopack)
 * tidak gagal, dan agar deploy ke Vercel maupun Netlify (OpenNext adapter)
 * berjalan tanpa konfigurasi tambahan.
 *
 * Fokus konfigurasi ini adalah keamanan, karena private key burner wallet
 * disimpan di localStorage: satu celah XSS = dompet terkuras. CSP di bawah
 * membatasi ke domain mana saja JavaScript halaman boleh mengirim data
 * (connect-src), sehingga skrip jahat yang berhasil masuk tetap sulit
 * mengirim private key keluar.
 *
 * Saat build di Vercel/Netlify/CI, config ini juga MENGECEK env var wajib.
 * Bila kosong, build berhenti dengan pesan jelas — lebih baik daripada situs
 * online tapi tidak bisa trading. (Build lokal tidak dicek.)
 */

import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

const isDev = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------
// Cek environment variable saat build di hosting
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
  {
    name: "NEXT_PUBLIC_HELIUS_RPC_URL",
    valid: (value) => /^https:\/\/\S+$/.test(value),
    hint: "URL RPC Helius untuk browser, contoh https://mainnet.helius-rpc.com/?api-key=KEY_ANDA",
  },
  {
    name: "JUPITER_API_KEY",
    valid: (value) => value.length >= 8,
    hint: "API key dari https://developers.jup.ag/portal",
  },
];

const RECOMMENDED_ENV = [
  {
    name: "TERMINAL_ACCESS_KEY",
    hint: "tanpa ini, /api/** bisa dipakai siapa saja yang tahu URL situs Anda",
  },
];

function isHostedBuild() {
  return Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.CI);
}

function assertDeployEnv() {
  if (!isHostedBuild() || process.env.SKIP_ENV_CHECK === "1") return;

  const problems = [];
  for (const item of REQUIRED_ENV) {
    const value = (process.env[item.name] ?? "").trim();
    if (!value) {
      problems.push(`  • ${item.name} belum diisi — ${item.hint}`);
    } else if (/GANTI_DENGAN/i.test(value) || !item.valid(value)) {
      problems.push(`  • ${item.name} masih berisi contoh atau formatnya salah — ${item.hint}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "",
        "Environment variable WAJIB untuk deploy belum lengkap:",
        ...problems,
        "",
        "Isi di dashboard hosting, lalu deploy ulang:",
        "  Vercel  : Project → Settings → Environment Variables (centang Production & Preview)",
        "  Netlify : Project configuration → Environment variables",
        "Darurat saja: SKIP_ENV_CHECK=1 melewati cek ini (terminal TIDAK akan bisa trading).",
        "",
      ].join("\n"),
    );
  }

  for (const item of RECOMMENDED_ENV) {
    if (!(process.env[item.name] ?? "").trim()) {
      console.warn(`⚠  ${item.name} kosong: ${item.hint}.`);
    }
  }
}

/**
 * Ambil origin (protocol + host) dari sebuah URL env, tanpa query string
 * seperti `?api-key=...`. Return null jika env kosong atau tidak valid.
 * @param {string | undefined} value
 * @returns {string | null}
 */
function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Domain yang boleh dihubungi browser (fetch / WebSocket). */
const connectSources = [
  "'self'",
  // Helius RPC (HTTP + WebSocket) & Helius Sender
  "https://*.helius-rpc.com",
  "wss://*.helius-rpc.com",
  // DexScreener API (harga, market cap, likuiditas, volume)
  "https://api.dexscreener.com",
  // Catatan: Jupiter & Jito SENGAJA tidak ada di sini. Keduanya dipanggil lewat
  // API route server (/api/jupiter/*, /api/jito/*) agar API key tidak bocor.
  // Origin dari env (jika user memakai RPC selain Helius, mis. Secure RPC URL kustom)
  originOf(process.env.NEXT_PUBLIC_HELIUS_RPC_URL),
  originOf(process.env.NEXT_PUBLIC_HELIUS_WS_URL),
  originOf(process.env.NEXT_PUBLIC_HELIUS_SENDER_URL),
  originOf(process.env.NEXT_PUBLIC_DEXSCREENER_API_URL),
  // Hot reload Next.js saat development
  isDev ? "ws://localhost:*" : null,
  isDev ? "http://localhost:*" : null,
].filter(Boolean);

const contentSecurityPolicy = [
  "default-src 'self'",
  // Next.js App Router menyisipkan inline script untuk hydration.
  // 'unsafe-eval' hanya di dev (dibutuhkan React DevTools / HMR).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  // Logo token datang dari banyak host (DexScreener CDN, IPFS gateway, Arweave, dll.)
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${[...new Set(connectSources)].join(" ")}`,
  // Terminal tidak boleh di-embed di iframe situs lain (cegah clickjacking tombol Buy/Sell 1-klik).
  "frame-ancestors 'none'",
  // Satu-satunya iframe yang diizinkan: grafik live DexScreener.
  "frame-src https://dexscreener.com https://*.dexscreener.com",
  // Web Worker heartbeat (/workers/heartbeat.js) agar timer tidak diperlambat saat tab di background.
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  isDev ? null : "upgrade-insecure-requests",
]
  .filter(Boolean)
  .join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Jangan bocorkan URL (yang bisa berisi CA / alamat wallet) ke situs lain.
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Logo token berasal dari host acak; optimasi gambar Next.js tidak dibutuhkan
  // dan bisa memakan kuota image optimization di Vercel/Netlify.
  images: {
    unoptimized: true,
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Respons API (proxy Jupiter/Jito/priority fee) tidak boleh di-cache CDN,
        // karena berisi quote & blockhash yang kedaluwarsa dalam hitungan detik.
        source: "/api/:path*",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

/** @param {string} phase */
export default function config(phase) {
  if (phase === PHASE_PRODUCTION_BUILD) assertDeployEnv();
  return nextConfig;
}
