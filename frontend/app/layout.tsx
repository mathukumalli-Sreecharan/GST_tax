import type { Metadata } from "next";
import "./globals.css";
import "geist/font/sans";

export const metadata: Metadata = {
  title: "GST Ledger Studio",
  description: "Local GST rate review and Excel processing workspace",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
