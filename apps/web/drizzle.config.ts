import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { defineConfig } from "drizzle-kit"

/**
 * The repo keeps a single .env at the root so the Python control plane and the
 * web app read the same DATABASE_URL rather than drifting apart.
 *
 * Parsed here directly instead of pulling in dotenv: this is the only place the
 * web package needs it, and drizzle-kit runs the config outside Next's own env
 * loading.
 */
function loadRootEnv(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), "../../.env"), "utf8")
    const out: Record<string, string> = {}
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
    }
    return out
  } catch {
    return {}
  }
}

const env = loadRootEnv()
const url = process.env.DATABASE_URL ?? env.DATABASE_URL

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the repo root and fill it in.",
  )
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
