/**
 * Cermin reaktif dari wallet.ts (status lock/unlock + saldo SOL live).
 * Keypair TIDAK pernah disimpan di store ini — hanya public key & saldo.
 */

import { create } from "zustand";
import { getWalletState, onWalletStateChange, type WalletState } from "@/lib/wallet";

interface WalletStoreState extends WalletState {
  solLamports: number | null;
  balanceSlot: number;
  balanceUpdatedAt: number | null;
  balanceError: string | null;
  syncFromWallet: () => void;
  setBalance: (lamports: number, slot: number) => void;
  setBalanceError: (message: string | null) => void;
}

const INITIAL: WalletState = { status: "none", publicKey: null, unlockedAt: null };

export const useWalletStore = create<WalletStoreState>()((set, get) => ({
  ...(typeof window === "undefined" ? INITIAL : getWalletState()),
  solLamports: null,
  balanceSlot: -1,
  balanceUpdatedAt: null,
  balanceError: null,

  syncFromWallet: () => {
    const next = getWalletState();
    const previousKey = get().publicKey;
    set({
      ...next,
      ...(next.publicKey !== previousKey
        ? { solLamports: null, balanceSlot: -1, balanceUpdatedAt: null, balanceError: null }
        : {}),
    });
  },
  setBalance: (lamports, slot) => {
    if (slot < get().balanceSlot) return;
    set({ solLamports: lamports, balanceSlot: slot, balanceUpdatedAt: Date.now(), balanceError: null });
  },
  setBalanceError: (message) => set({ balanceError: message }),
}));

if (typeof window !== "undefined") {
  onWalletStateChange(() => useWalletStore.getState().syncFromWallet());
}
