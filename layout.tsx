import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || "Meme Terminal";

export const metadata: Metadata = {
  title: `${APP_NAME} · Solana`,
  description: "Trading terminal meme coin Solana: burner wallet 1-klik, Jupiter, Jito, Auto TP/SL.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0d12",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" className="bg-bg">
      <body className="bg-bg text-fg antialiased">{children}</body>
    </html>
  );
}
