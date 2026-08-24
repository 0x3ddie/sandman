import { redirect } from "next/navigation"

/**
 * There is no separate sign-up. Accounts are created by the identity provider
 * on first sign-in, so the marketing CTAs land here and continue to one page.
 */
export default function SignUpPage() {
  redirect("/sign-in")
}
