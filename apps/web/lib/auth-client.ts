"use client"

import { createAuthClient } from "better-auth/react"

/**
 * Browser-side auth. The base URL is left to better-auth's default (the current
 * origin) so the client works unchanged whether the app is served from
 * localhost or anywhere else.
 */
export const authClient = createAuthClient()

export const { signIn, signOut, signUp, useSession } = authClient
