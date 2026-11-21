/**
 * src/lib/server/guard.ts — Penjaga API routes (hanya berjalan di server)
 *
 * Bila TERMINAL_ACCESS_KEY diisi, setiap request ke /api/** wajib membawa header
 * `x-terminal-key` yang sama. Perbandingan memakai timingSafeEqual agar kunci
 * tidak bisa ditebak lewat perbedaan waktu respons.
 */

import "server-only";
import { timingSafeEqual } from "node:crypto";

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0", ...headers },
  });
}

export function jsonError(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

/** Return Response 401 bila akses ditolak, atau null bila boleh lanjut. */
export function checkTerminalAccess(request: Request): Response | null {
  const expected = process.env.TERMINAL_ACCESS_KEY?.trim();
  if (!expected) return null;

  const provided = request.headers.get("x-terminal-key")?.trim() ?? "";
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");

  const valid = expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
  if (!valid) {
    return jsonError("Akses ditolak: header x-terminal-key salah atau kosong.", 401);
  }
  return null;
}

const BASE58_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isBase58Address(value: string | null): value is string {
  return typeof value === "string" && BASE58_ADDRESS_REGEX.test(value);
}
