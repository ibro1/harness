/**
 * Host loader entry for the browser implementation exported from `./client`.
 *
 * The sign-in target that clears the sibling browser gate is NOT registered
 * here. It needs the `connection` service, which the Web application mounts
 * inside its own bundle scope: a row inserted at the composition root sees
 * `webServer` but never `connection`, so its injection would silently never
 * fire. That wiring therefore stays in the bundle that owns both.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis function-plugin name. */
export const name = 'harness-account'

/**
 * Mount nothing on the Host; the browser half carries this package's contributions.
 * @param _ctx - host context.
 */
export function apply(_ctx: Context): void {
  // Intentionally empty: see the module comment.
}
