import type { Metadata } from "next";
import { Manrope, Syne } from "next/font/google";

import "./globals.css";

const headingFont = Syne({
  subsets: ["latin"],
  variable: "--font-heading",
  weight: ["500", "700", "800"],
});

const bodyFont = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Last30Days Opportunity Studio",
  description:
    "Run trend-first Reddit/X/Web research on the last 30 days, generate proof-backed AI opportunities, and produce PRD, Market Plan, and Execution Plan outputs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${headingFont.variable} ${bodyFont.variable}`}>{children}</body>
    </html>
  );
}
