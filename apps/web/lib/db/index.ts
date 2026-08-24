/**
 * The Drizzle client.
 *
 * Two things shape this module.
 *
 * Next's dev server re-evaluates modules on every hot reload. Without a
 * global-scoped singleton that means a fresh postgres.js pool per edit, and a
 * few minutes of iteration is enough to exhaust `max_connections` on a local
 * Postgres. The pool is therefore parked on `globalThis`, which survives HMR.
 *
 * The pool is also created on first *use* rather than on import, so a build that
 * merely imports a route module does not fail on a missing DATABASE_URL.
 */

import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

import * as schema from "./schema"

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Postgres from docker-compose.yml, " +
        "e.g. postgresql://sandman:sandman@localhost:5433/sandman",
    )
  }
  return url
}

function createDatabase() {
  const client = postgres(connectionString(), {
    // The dashboard is read-heavy and every request is short. A small pool is
    // plenty, and leaves headroom for the control plane's own connections.
    max: process.env.NODE_ENV === "production" ? 10 : 4,
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    onnotice: () => {},
  })
  return drizzle(client, { schema })
}

export type Database = ReturnType<typeof createDatabase>

const globalForDb = globalThis as unknown as { __sandmanDb?: Database }

function database(): Database {
  const existing = globalForDb.__sandmanDb
  if (existing) return existing
  const created = createDatabase()
  globalForDb.__sandmanDb = created
  return created
}

/**
 * Behaves as the Drizzle database in every respect; the indirection exists only
 * so that connecting is deferred to the first property access.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    const instance = database()
    const value = Reflect.get(instance as object, property) as unknown
    return typeof value === "function" ? value.bind(instance) : value
  },
  has(_target, property) {
    return Reflect.has(database() as object, property)
  },
})

export { schema }
export * from "./schema"
