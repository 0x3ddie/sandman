import * as React from "react"
import type { Metadata } from "next"
import { Geist_Mono, Instrument_Sans, Instrument_Serif } from "next/font/google"
import { Toaster } from "sonner"

import "./globals.css"

// .text-display-1/-2 narrow the UI face with font-stretch, which only resolves
// if the width axis is actually loaded — next/font ships wght alone by default.
const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
})

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
})

export const metadata: Metadata = {
  title: "sandman",
  description: "Pen-tests your rollout before it ships.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${instrumentSans.variable} ${geistMono.variable} ${instrumentSerif.variable} grain min-h-dvh bg-[var(--bg-base)] text-[var(--fg-primary)]`}
      >
        {children}
        <Toaster
          position="bottom-left"
          theme="dark"
          offset={20}
          visibleToasts={4}
          toastOptions={{
            style: {
              background: "var(--bg-overlay)",
              border: "1px solid var(--border-default)",
              borderRadius: "8px",
              boxShadow: "var(--elev-2)",
              color: "var(--fg-primary)",
              fontFamily: "var(--font-instrument-sans)",
              fontSize: "13px",
              letterSpacing: "-0.005em",
            },
          }}
        />
      </body>
    </html>
  )
}
