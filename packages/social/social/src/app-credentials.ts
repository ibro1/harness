/**
 * How a provider finds the application credentials it signs in with.
 *
 * Every provider in this group authenticates twice over. The **application**
 * credentials — a client id, a secret, a redirect URI — identify the operator's
 * registered app to the platform and are set once per deployment. The
 * **account** credential is the token the sign-in flow returns, and it is the
 * credential seam's business alone; nothing here touches it.
 *
 * The three providers were written in parallel and landed on three different
 * answers for the first kind, which is why this is one function rather than
 * three. The order it fixes is: what a person typed into settings, then what
 * the composition wrote into `cordis.yml`, then the environment variable the
 * composition names. Settings wins because it is the layer a person can change
 * without a redeploy, and a value typed into a form and then ignored is worse
 * than one that was never offered.
 *
 * A secret does not belong in a settings document, so no provider puts one
 * there: the secret is addressed by *reference* and resolved through the
 * credential seam, which is also what lets the settings card write it without
 * ever reading it back.
 *
 * @module @deepseek-ai/dsh-social/app-credentials
 */

/** The layers one application credential can come from, in precedence order. */
export interface AppCredentialLayers {
  /** What a person typed into the settings section, when they typed anything. */
  settings?: string | undefined
  /** What the composition wrote into this plugin's `cordis.yml` config. */
  config?: string | undefined
  /** Name of the environment variable or credential record holding it. */
  ref?: string | undefined
}

/** Which layer supplies a credential, or that none does. */
export type AppCredentialSource =
  /** A value given outright; `layer` names where a person would go to change it. */
  | { kind: 'literal'; value: string; layer: 'settings' | 'config' }
  /** A name to resolve through the credential seam. */
  | { kind: 'reference'; ref: string }
  /** No layer offers one. */
  | { kind: 'absent' }

/** Everything a refusal needs to tell a person where to put the value. */
export interface AppCredentialSubject {
  /** The platform, as a person names it: `LinkedIn`, `Meta`, `Google`. */
  platform: string
  /** The credential, as its console names it: `client id`, `app secret`. */
  what: string
}

/**
 * Treat blank as absent. A settings field cleared back to empty means "I do not
 * supply this", not "supply the empty string", and an empty environment
 * variable is the same statement.
 * @param value - the layer's raw value.
 * @returns the trimmed value, or undefined when it carries nothing.
 */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * The first layer that carries anything, in the order given.
 *
 * The same precedence as {@link chooseAppCredential} for the values that are
 * not credentials at all — a redirect URI, a public media base, the *name* of
 * the variable a secret lives in. They follow the same settings-over-config
 * order because a person changing one in the card means it, and a mixed rule
 * across a single form is the kind of thing nobody can hold in their head.
 *
 * @param values - each layer's value, highest precedence first.
 * @returns the first non-blank value, trimmed, or undefined when none is.
 */
export function firstConfigured(...values: ReadonlyArray<string | undefined>): string | undefined {
  for (const value of values) {
    const carried = present(value)
    if (carried !== undefined) return carried
  }
  return undefined
}

/**
 * Choose the layer that supplies one application credential.
 * @param layers - the values each layer offers.
 * @returns the winning source, or that none supplies it.
 */
export function chooseAppCredential(layers: AppCredentialLayers): AppCredentialSource {
  const settings = present(layers.settings)
  if (settings !== undefined) return { kind: 'literal', value: settings, layer: 'settings' }
  const config = present(layers.config)
  if (config !== undefined) return { kind: 'literal', value: config, layer: 'config' }
  const ref = present(layers.ref)
  return ref === undefined ? { kind: 'absent' } : { kind: 'reference', ref }
}

/**
 * Say where a missing credential could be put, naming every way that works.
 *
 * Written for the person reading it in a settings card or a tool refusal, so it
 * names the card first: that is the one of the three they can act on without a
 * redeploy.
 *
 * @param subject - the platform and the credential, as their console names them.
 * @param ref - the environment variable the composition names, if it names one.
 * @returns the sentence a refusal carries.
 */
export function missingAppCredential(subject: AppCredentialSubject, ref?: string): string {
  const named = present(ref)
  const ways = [
    'enter it in Settings → Plugins → Social',
    ...named === undefined ? [] : [`set the ${named} environment variable`],
    'or give this plugin the value directly in its config',
  ]
  return `No ${subject.platform} ${subject.what} is configured: ${ways.join(', ')}.`
}

/**
 * Resolve one application credential through whichever layer supplies it.
 * @param layers - the values each layer offers.
 * @param subject - the platform and the credential, for the refusal.
 * @param resolve - reads a named reference through the credential seam.
 * @returns the credential's value.
 * @throws when no layer supplies one, or the named reference holds nothing —
 * always naming every place it could be put, because a caller who reaches this
 * has a value in hand and needs to know where it goes.
 */
export async function resolveAppCredential(
  layers: AppCredentialLayers,
  subject: AppCredentialSubject,
  resolve: (ref: string) => Promise<string | undefined>,
): Promise<string> {
  const source = chooseAppCredential(layers)
  if (source.kind === 'literal') return source.value
  if (source.kind === 'absent') throw new Error(missingAppCredential(subject))
  const resolved = present(await resolve(source.ref))
  if (resolved === undefined) throw new Error(missingAppCredential(subject, source.ref))
  return resolved
}
