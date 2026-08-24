/**
 * The better-auth handler.
 *
 * Every auth route — sign-in, the GitHub callback, sign-out, session lookup —
 * lands here. `toNextJsHandler` adapts better-auth's Request/Response handler to
 * the App Router's per-method exports.
 */

import { toNextJsHandler } from "better-auth/next-js"

import { auth } from "@/lib/auth"

// Auth responses set cookies and read headers; caching any of them would hand
// one user another user's session.
export const dynamic = "force-dynamic"

export const { GET, POST } = toNextJsHandler(auth.handler)
