/**
 * GET /api/jupiter/build — proxy ke Jupiter Swap API V2 /build
 *
 * JUPITER_API_KEY hanya ada di server. Parameter dari browser divalidasi dan
 * hanya parameter yang diizinkan yang diteruskan.
 */

import "server-only";
import { checkTerminalAccess, isBase58Address, jsonError } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PARAMS = [
  "inputMint",
  "outputMint",
  "amount",
  "taker",
  "slippageBps",
  "mode",
  "maxAccounts",
  "forJitoBundle",
  "wrapAndUnwrapSol",
  "dexes",
  "excludeDexes",
  "blockhashSlotsToExpiry",
] as const;

export async function GET(request: Request): Promise<Response> {
  const denied = checkTerminalAccess(request);
  if (denied) return denied;

  const apiKey = process.env.JUPITER_API_KEY?.trim();
  if (!apiKey) return jsonError("JUPITER_API_KEY belum diisi di environment server.", 500);

  const baseUrl = (process.env.JUPITER_API_BASE_URL || "https://api.jup.ag/swap/v2").replace(/\/+$/, "");
  const incoming = new URL(request.url).searchParams;

  const inputMint = incoming.get("inputMint");
  const outputMint = incoming.get("outputMint");
  const taker = incoming.get("taker");
  const amount = incoming.get("amount");
  const slippage = incoming.get("slippageBps");

  if (!isBase58Address(inputMint) || !isBase58Address(outputMint) || !isBase58Address(taker)) {
    return jsonError("inputMint, outputMint, dan taker harus alamat Base58 yang valid.", 400);
  }
  if (inputMint === outputMint) {
    return jsonError("inputMint dan outputMint tidak boleh sama.", 400);
  }
  if (!amount || !/^\d{1,30}$/.test(amount) || BigInt(amount) <= 0n) {
    return jsonError("amount harus bilangan bulat positif (satuan terkecil token).", 400);
  }
  if (slippage !== null && slippage !== "rtse") {
    const bps = Number(slippage);
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
      return jsonError("slippageBps harus 0–10000 atau 'rtse'.", 400);
    }
  }

  const forward = new URLSearchParams();
  for (const key of ALLOWED_PARAMS) {
    const value = incoming.get(key);
    if (value !== null && value !== "") forward.set(key, value);
  }

  try {
    const upstream = await fetch(`${baseUrl}/build?${forward.toString()}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return jsonError(
      isTimeout ? "Jupiter /build timeout (8 detik)." : `Gagal menghubungi Jupiter: ${String(error)}`,
      isTimeout ? 504 : 502,
    );
  }
}
