/**
 * The contract between a Server Action and the form that called it.
 *
 * Kept in its own module with no server imports so a client component can
 * import the type without dragging the database client into the bundle graph.
 */

export type ActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; field?: string }

export function failed(error: string, field?: string): ActionResult {
  return { ok: false, error, field }
}

export function succeeded(message: string): ActionResult {
  return { ok: true, message }
}
