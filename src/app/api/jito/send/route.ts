/**
 * POST /api/jito/send — proxy ke Jito Block Engine /api/v1/transactions
 *
 * Body: { transaction: string (base64, sudah ditandatangani), bundleOnly?: boolean }
 *
 * Kenapa lewat server:
 * - Tidak bergantung pada kebijakan CORS Block Engine.
 * - JITO_AUTH_UUID (opsional) tetap rahasia.
 * - Bila satu region kena rate limit (default 1 req/detik per IP per region),
 *   otomatis dicoba ke region berikutnya. Penting di Vercel/Netlify karena IP
 *   keluar serverless dipakai bersama banyak pengguna lain.
 *
 * Server TIDAK pernah melihat private key — hanya transaksi yang sudah ditandatangani.
 */

import "server-only";
import { checkTerminalAccess, jsonError, jsonResponse } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRANSACTION_BYTES = 1_232;
const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 2_500;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

const FALLBACK_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf",
  "https://singapore.mainnet.block-engine.jito.wtf",
  "https://tokyo.mainnet.block-engine.jito.wtf",
  "https://frankfurt.mainnet.block-engine.jito.wtf",
  "https://ny.mainnet.block-engine.jito.wtf",
  "https://amsterdam.mainnet.block-engine.jito.wtf",
];

interface JitoRpcResponse {
  result?: string;
  error?: { code?: number; message?: string };
}

function isRateLimited(status: number, body: JitoRpcResponse | null): boolean {
  if (status === 429) return true;
  const message = body?.error?.message?.toLowerCase() ?? "";
  return message.includes("rate limit") || message.includes("rate-limit") || body?.error?.code === -32097;
}

export async function POST(request: Request): Promise<Response> {
  const denied = checkTerminalAccess(request);
  if (denied) return denied;

  let payload: { transaction?: unknown; bundleOnly?: unknown };
  try {
    payload = (await request.json()) as { transaction?: unknown; bundleOnly?: unknown };
  } catch {
    return jsonError("Body harus JSON.", 400);
  }

  const transaction = typeof payload.transaction === "string" ? payload.transaction.trim() : "";
  const bundleOnly = payload.bundleOnly === true;

  if (!transaction || !BASE64_REGEX.test(transaction)) {
    return jsonError("transaction harus string base64.", 400);
  }
  const decodedLength = Buffer.from(transaction, "base64").length;
  if (decodedLength < 100 || decodedLength > MAX_TRANSACTION_BYTES) {
    return jsonError(`Ukuran transaksi tidak wajar (${decodedLength} byte).`, 400);
  }

  const configured = (process.env.JITO_BLOCK_ENGINE_URL || "").replace(/\/+$/, "");
  const endpoints = [...new Set([configured, ...FALLBACK_ENDPOINTS].filter(Boolean))].slice(0, MAX_ATTEMPTS);
  const uuid = process.env.JITO_AUTH_UUID?.trim();

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (uuid) headers["x-jito-auth"] = uuid;

  const errors: string[] = [];
  for (const endpoint of endpoints) {
    const url = `${endpoint}/api/v1/transactions${bundleOnly ? "?bundleOnly=true" : ""}`;
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: [transaction, { encoding: "base64" }],
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });

      const text = await upstream.text();
      let body: JitoRpcResponse | null = null;
      try {
        body = text ? (JSON.parse(text) as JitoRpcResponse) : null;
      } catch {
        body = null;
      }

      if (isRateLimited(upstream.status, body)) {
        errors.push(`${new URL(endpoint).host}: rate limited`);
        continue;
      }
      if (upstream.status >= 500 && !body?.error) {
        errors.push(`${new URL(endpoint).host}: HTTP ${upstream.status}`);
        continue;
      }
      if (!upstream.ok || body?.error || typeof body?.result !== "string") {
        // Error transaksi (bukan jaringan) tidak akan berubah di region lain — langsung kembalikan.
        return jsonError(
          `Jito menolak transaksi: ${body?.error?.message ?? text.slice(0, 200) ?? `HTTP ${upstream.status}`}`,
          502,
        );
      }

      return jsonResponse({
        signature: body.result,
        bundleId: upstream.headers.get("x-bundle-id"),
        endpoint: new URL(endpoint).host,
        bundleOnly,
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      errors.push(`${new URL(endpoint).host}: ${name === "TimeoutError" ? "timeout" : String(error)}`);
    }
  }

  return jsonError(`Semua endpoint Jito gagal (${errors.join("; ")}).`, 502);
}
