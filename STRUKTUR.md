# Struktur Folder — Solana Meme Terminal

```
solana-meme-terminal/
├── .env.example · .gitignore · eslint.config.mjs · netlify.toml · vercel.json
├── next.config.mjs                 # CSP (iframe DexScreener, worker), header keamanan
├── package.json · postcss.config.mjs · tsconfig.json
├── public/
│   └── workers/heartbeat.js        # timer di Web Worker → tidak diperlambat saat tab di background
└── src/
    ├── app/
    │   ├── globals.css             # tema dark terminal (Tailwind v4 @theme)
    │   ├── layout.tsx
    │   ├── page.tsx                # Header + Scanner/Chart + Trade/Automation + Posisi
    │   └── api/
    │       ├── jupiter/build/route.ts   # proxy Swap API V2 /build (API key di server)
    │       └── jito/send/route.ts       # proxy Jito + fallback region
    ├── components/
    │   ├── Header.tsx              # status RPC, saldo SOL, Generate/Import/Export/Kunci
    │   ├── ScannerPanel.tsx        # input CA, market stats, iframe chart, skor keamanan, top holders
    │   ├── TradePanel.tsx          # tab Buy / Sell / Auto TP/SL, pengaturan eksekusi, progress tx
    │   ├── AutoSellForm.tsx        # form TP bertingkat, SL, trailing, status live
    │   ├── PositionsTable.tsx      # avg beli, harga kini, nilai, PnL live, Panic Sell 100%
    │   ├── WalletDialogs.tsx       # create / import / unlock / export / kunci akses
    │   ├── Toaster.tsx
    │   └── ui.tsx                  # Button, Input, Panel, Badge, Modal, Toggle, Stat
    ├── hooks/
    │   ├── useAutoSell.ts          # mesin Auto TP / SL / Trailing Stop
    │   ├── usePositions.ts         # saldo on-chain + jurnal + harga live → PnL
    │   ├── usePriceFeed.ts         # berlangganan price feed bersama
    │   ├── useTokenScan.ts · useTokenBalance.ts · useRpcHealth.ts
    │   ├── useWalletBootstrap.ts   # saldo SOL live, auto-lock, unlock audio
    │   └── useNow.ts
    ├── lib/
    │   ├── rpc.ts · wallet.ts · scanner.ts · swap.ts      # mesin inti (tahap 2)
    │   ├── price-feed.ts           # SATU polling DexScreener 2 dtk untuk semua mint
    │   ├── trade-actions.ts        # jalur eksekusi tunggal: manual, panic, auto-sell
    │   ├── heartbeat.ts · sound.ts · format.ts
    │   └── server/guard.ts
    └── store/                      # zustand
        ├── settings-store.ts       # slippage, fee, tip, mode kirim (persist)
        ├── journal-store.ts        # jurnal trade → harga beli rata-rata & realized PnL (persist)
        ├── auto-sell-store.ts      # aturan TP/SL + status level tereksekusi (persist)
        ├── wallet-store.ts · trade-store.ts · toast-store.ts · ui-store.ts
```

## Status

1. ✅ Konfigurasi proyek
2. ✅ Mesin inti: wallet terenkripsi, scanner, swap Jupiter V2 + Jito
3. ✅ UI terminal + Auto TP/SL/Trailing + posisi & PnL
