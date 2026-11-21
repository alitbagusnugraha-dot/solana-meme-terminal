"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  MIN_PASSWORD_LENGTH,
  WalletError,
  assessPasswordStrength,
  createAndStoreWallet,
  deleteStoredWallet,
  exportSecretKeyBase58,
  hasStoredWallet,
  importAndStoreWallet,
  unlockWallet,
} from "@/lib/wallet";
import { getTerminalAccessKey, setTerminalAccessKey } from "@/lib/swap";
import { toError } from "@/lib/rpc";
import { useUiStore } from "@/store/ui-store";
import { useWalletStore } from "@/store/wallet-store";
import { pushToast } from "@/store/toast-store";
import { Badge, Button, CopyButton, Field, Input, Modal } from "./ui";

function errorMessage(error: unknown): string {
  return error instanceof WalletError ? error.message : toError(error).message;
}

function StrengthHint({ password }: { password: string }) {
  if (!password) return <>Minimal {MIN_PASSWORD_LENGTH} karakter. Disarankan frasa panjang.</>;
  const strength = assessPasswordStrength(password);
  const tone = strength === "kuat" ? "up" : strength === "sedang" ? "warn" : "down";
  return (
    <span className="flex items-center gap-1">
      Kekuatan: <Badge tone={tone}>{strength}</Badge>
    </span>
  );
}

function SecurityWarning() {
  return (
    <div className="rounded-md border border-warn/40 bg-warn/5 p-2.5 text-[11px] leading-relaxed text-warn">
      <strong>Burner wallet = hot wallet.</strong> Private key tersimpan terenkripsi di browser ini dan
      dipakai untuk menandatangani otomatis tanpa pop-up. Isi hanya dengan modal trading secukupnya,
      jangan pakai wallet utama, dan jangan pasang ekstensi browser yang tidak Anda percaya.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function CreateWalletDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ publicKey: string; secret: string } | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [existing] = useState(() => hasStoredWallet());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Konfirmasi password tidak sama.");
      return;
    }
    if (existing && !overwrite) {
      setError("Centang opsi timpa wallet lama (pastikan private key lama sudah di-backup).");
      return;
    }
    setBusy(true);
    try {
      const result = await createAndStoreWallet(password, { overwrite });
      setCreated({ publicKey: result.publicKey, secret: result.secretKeyBase58 });
      useWalletStore.getState().syncFromWallet();
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted">Wallet dibuat dan sudah terbuka. Simpan private key ini SEKARANG — tidak akan ditampilkan lagi tanpa password.</p>
        <Field label="Alamat wallet (untuk deposit SOL)">
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-bg p-2 font-mono text-xs">{created.publicKey}</code>
            <CopyButton value={created.publicKey} />
          </div>
        </Field>
        <Field label="Private key (Base58) — RAHASIA">
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded border border-down/40 bg-bg p-2 font-mono text-[11px] text-down">{created.secret}</code>
            <CopyButton value={created.secret} />
          </div>
        </Field>
        <label className="flex items-center gap-2 text-xs text-fg">
          <input type="checkbox" checked={backedUp} onChange={(event) => setBackedUp(event.target.checked)} />
          Saya sudah menyimpan private key di tempat aman.
        </label>
        <Button variant="primary" disabled={!backedUp} onClick={onClose}>
          Selesai
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <SecurityWarning />
      <Field label="Password enkripsi" hint={<StrengthHint password={password} />}>
        <Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      <Field label="Ulangi password">
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </Field>
      {existing ? (
        <label className="flex items-center gap-2 text-xs text-warn">
          <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
          Timpa wallet lama di browser ini (pastikan sudah di-backup).
        </label>
      ) : null}
      {error ? <p className="text-xs text-down">{error}</p> : null}
      <Button type="submit" variant="primary" loading={busy}>
        Generate wallet baru
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function ImportWalletDialog({ onClose }: { onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing] = useState(() => hasStoredWallet());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Konfirmasi password tidak sama.");
      return;
    }
    if (existing && !overwrite) {
      setError("Centang opsi timpa wallet lama untuk melanjutkan.");
      return;
    }
    setBusy(true);
    try {
      const result = await importAndStoreWallet(secret, password, { overwrite });
      setSecret("");
      useWalletStore.getState().syncFromWallet();
      pushToast({ kind: "success", title: "Wallet diimpor", message: result.publicKey });
      onClose();
    } catch (importError) {
      setError(errorMessage(importError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <SecurityWarning />
      <Field label="Private key" hint="Base58 (export Phantom/Solflare) atau array JSON 64 angka (Solana CLI).">
        <textarea
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          className="w-full rounded-md border border-line bg-bg p-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
        />
      </Field>
      <Field label="Password enkripsi" hint={<StrengthHint password={password} />}>
        <Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      <Field label="Ulangi password">
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
      </Field>
      {existing ? (
        <label className="flex items-center gap-2 text-xs text-warn">
          <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
          Timpa wallet lama di browser ini.
        </label>
      ) : null}
      {error ? <p className="text-xs text-down">{error}</p> : null}
      <Button type="submit" variant="primary" loading={busy} disabled={!secret.trim()}>
        Import & enkripsi
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------

function UnlockDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await unlockWallet(password);
      setPassword("");
      useWalletStore.getState().syncFromWallet();
      onClose();
    } catch (unlockError) {
      setError(errorMessage(unlockError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label="Password wallet">
        <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </Field>
      {error ? <p className="text-xs text-down">{error}</p> : null}
      <Button type="submit" variant="primary" loading={busy} disabled={!password}>
        Buka kunci
      </Button>
      <p className="text-[11px] text-dim">Dekripsi memakai 600.000 iterasi PBKDF2 — butuh ±0,5 detik.</p>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Export & hapus
// ---------------------------------------------------------------------------

const REVEAL_SECONDS = 30;

function ExportDialog({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState("");

  useEffect(() => {
    if (!secret) return undefined;
    const timer = setTimeout(() => setSecret(null), REVEAL_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [secret]);

  const reveal = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setSecret(await exportSecretKeyBase58(password));
      setPassword("");
    } catch (exportError) {
      setError(errorMessage(exportError));
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    deleteStoredWallet();
    useWalletStore.getState().syncFromWallet();
    pushToast({ kind: "warning", title: "Wallet dihapus dari browser ini" });
    onClose();
  };

  return (
    <div className="flex flex-col gap-4">
      {secret ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-warn">Private key disembunyikan otomatis dalam {REVEAL_SECONDS} detik. Jangan screenshot / bagikan.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded border border-down/40 bg-bg p-2 font-mono text-[11px] text-down">{secret}</code>
            <CopyButton value={secret} />
          </div>
          <Button variant="outline" onClick={() => setSecret(null)}>
            Sembunyikan
          </Button>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={reveal}>
          <Field label="Masukkan password untuk menampilkan private key">
            <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          {error ? <p className="text-xs text-down">{error}</p> : null}
          <Button type="submit" variant="primary" loading={busy} disabled={!password}>
            Tampilkan private key
          </Button>
        </form>
      )}

      <div className="rounded-md border border-down/40 p-3">
        <div className="mb-2 text-xs font-semibold text-down">Zona bahaya: hapus wallet dari browser ini</div>
        <p className="mb-2 text-[11px] text-muted">Tidak bisa dibatalkan. Dana tetap ada on-chain, tapi hanya bisa diakses dengan private key yang sudah Anda backup.</p>
        <div className="flex gap-2">
          <Input placeholder='Ketik "HAPUS"' value={confirmDelete} onChange={(event) => setConfirmDelete(event.target.value)} />
          <Button variant="danger" disabled={confirmDelete !== "HAPUS"} onClick={remove}>
            Hapus
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kunci akses API
// ---------------------------------------------------------------------------

function AccessKeyDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState(() => getTerminalAccessKey() ?? "");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTerminalAccessKey(value.trim() || null);
        pushToast({ kind: "info", title: value.trim() ? "Kunci akses disimpan" : "Kunci akses dihapus" });
        onClose();
      }}
    >
      <p className="text-xs text-muted">
        Isi dengan nilai <code className="text-fg">TERMINAL_ACCESS_KEY</code> dari environment server. Dibutuhkan agar
        proxy Jupiter/Jito menerima request dari browser ini.
      </p>
      <Field label="Kunci akses terminal">
        <Input type="password" autoComplete="off" value={value} onChange={(event) => setValue(event.target.value)} />
      </Field>
      <Button type="submit" variant="primary">
        Simpan
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

const TITLES = {
  create: "Generate burner wallet",
  import: "Import private key",
  unlock: "Buka kunci wallet",
  export: "Export private key",
  "access-key": "Kunci akses API",
} as const;

export function WalletDialogs() {
  const dialog = useUiStore((state) => state.dialog);
  const closeDialog = useUiStore((state) => state.closeDialog);

  return (
    <Modal open={dialog !== null} onClose={closeDialog} title={dialog ? TITLES[dialog] : ""}>
      {dialog === "create" ? <CreateWalletDialog onClose={closeDialog} /> : null}
      {dialog === "import" ? <ImportWalletDialog onClose={closeDialog} /> : null}
      {dialog === "unlock" ? <UnlockDialog onClose={closeDialog} /> : null}
      {dialog === "export" ? <ExportDialog onClose={closeDialog} /> : null}
      {dialog === "access-key" ? <AccessKeyDialog onClose={closeDialog} /> : null}
    </Modal>
  );
}
