"use client";

import { useEffect } from "react";
import { configureAutoLock, touchWalletSession, watchSolBalance } from "@/lib/wallet";
import { setSoundEnabled, unlockAudio } from "@/lib/sound";
import { subscribeHeartbeat } from "@/lib/heartbeat";
import { useWalletStore } from "@/store/wallet-store";
import { useSettingsStore } from "@/store/settings-store";
import { useJournalStore } from "@/store/journal-store";

/**
 * Dipanggil SEKALI di halaman terminal:
 * - saldo SOL live (WebSocket + polling cadangan)
 * - auto-lock wallet sesuai pengaturan
 * - membuka kunci audio pada interaksi pertama user
 */
export function useWalletBootstrap(options: { hasActiveAutoSell: boolean }): void {
  const publicKey = useWalletStore((state) => state.publicKey);
  const autoLockMinutes = useSettingsStore((state) => state.autoLockMinutes);
  const keepUnlocked = useSettingsStore((state) => state.keepUnlockedWhileAutoSell);
  const soundEnabled = useSettingsStore((state) => state.soundEnabled);
  const holdingsNonce = useJournalStore((state) => state.holdingsNonce);

  useEffect(() => {
    if (!publicKey) return undefined;
    return watchSolBalance(
      publicKey,
      (balance) => useWalletStore.getState().setBalance(balance.lamports, balance.slot),
      {
        pollIntervalMs: 15_000,
        onError: (error) => useWalletStore.getState().setBalanceError(error.message),
      },
    );
  }, [publicKey, holdingsNonce]);

  useEffect(() => {
    configureAutoLock(autoLockMinutes > 0 ? autoLockMinutes : null);
  }, [autoLockMinutes]);

  // Saat mesin Auto TP/SL punya aturan aktif, jaga sesi tetap terbuka agar bisa menandatangani.
  useEffect(() => {
    if (!options.hasActiveAutoSell || !keepUnlocked) return undefined;
    return subscribeHeartbeat(() => touchWalletSession());
  }, [options.hasActiveAutoSell, keepUnlocked]);

  useEffect(() => {
    setSoundEnabled(soundEnabled);
  }, [soundEnabled]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
}
