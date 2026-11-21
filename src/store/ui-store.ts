/**
 * State UI sementara (dialog yang sedang terbuka).
 */

import { create } from "zustand";

export type DialogKind = "create" | "import" | "unlock" | "export" | "access-key" | null;

interface UiState {
  dialog: DialogKind;
  openDialog: (dialog: Exclude<DialogKind, null>) => void;
  closeDialog: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  dialog: null,
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),
}));
