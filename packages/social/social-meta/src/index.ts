/**
 * Facebook Pages and Instagram professional accounts, as the `facebook` and
 * `instagram` social providers.
 *
 * Both networks are published through the same Meta Graph API, under one Meta
 * app and one sign-in, so they are one plugin registering two providers: the
 * authorization flow obtains a long-lived user token, and every Page token and
 * Instagram account is derived from it on each operation. Mount the plugin once
 * per Meta account, giving each mount its own `account` id.
 *
 * What this package cannot decide for you is App Review. `pages_manage_posts`
 * and `instagram_content_publish` are granted to an app only after Meta reviews
 * it, and until then they work solely for people with a role on the app — so
 * the granted permissions are read from the token and reported on every target,
 * rather than being found out by a post failing.
 *
 * @module @deepseek-ai/dsh-social-meta
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-authorization'
import { credentialKey, credentialRef, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import type { GraphEndpoint } from './graph.ts'
import { metaAuthorizationFlow } from './oauth.ts'
import { createMetaProviders } from './provider.ts'

export type {
  MetaGrant, MetaPage, SocialAccepts, SocialMedia, SocialPostRequest, SocialPostResult, SocialProvider,
  SocialTarget,
} from './types.ts'
export { MetaGraphError } from './graph.ts'
export { createMetaProviders, FACEBOOK_PROVIDER_NAME, INSTAGRAM_PROVIDER_NAME } from './provider.ts'
export type { MetaNetwork, MetaProviderOptions } from './provider.ts'
export { metaAuthorizationFlow } from './oauth.ts'
// The seam declares `Context.social`; `inject` above makes it present by `apply`.
import type {} from '@deepseek-ai/dsh-social'
import { firstConfigured, resolveAppCredential } from '@deepseek-ai/dsh-social'
// Type-only merge: declares `Context.settings`, awaited in a scope in `apply`.
import type {} from '@deepseek-ai/dsh-settings'

/** The plugin name, for the Loader. It is also the scope of this plugin's credential records. */
export const name = 'social-meta'

/** The services this plugin contributes to and reads. */
export const inject = ['social', 'credentials', 'authorization']

/** Composition config. */
export interface Config {
  /** Which Meta account this mount holds, as the id half of its credential record key. */
  account: string
  /** The Meta app id, when the composition gives it outright. */
  appId: string
  /** Environment-variable name holding the Meta app id. */
  appIdRef: string
  /** Environment-variable name holding the Meta app secret. */
  appSecretRef: string
  /** A redirect URI listed on the Meta app; the sign-in lands there and the human copies the URL back. */
  redirectUri: string
  /** Whether Instagram permissions are requested and Instagram targets offered. */
  instagram: boolean
  /** Base URL local media is served under, so Instagram can fetch it; empty when there is none. */
  publicMediaBaseUrl: string
  /** Graph API version every call is made against. */
  graphVersion: string
  /** Origin of the Graph API. */
  graphBaseUrl: string
  /** Origin of the video host a finished upload is published through. */
  graphVideoBaseUrl: string
  /** Origin of the login dialog. */
  loginBaseUrl: string
  /** Milliseconds one Graph call may take. */
  timeoutMs: number
  /** Milliseconds between Instagram container status checks. */
  containerPollIntervalMs: number
  /** Milliseconds to wait in total for an Instagram container to finish processing. */
  containerTimeoutMs: number
  /** How many days before the user token expires a ready target starts warning about it. */
  tokenExpiryWarningDays: number
}

/**
 * Composition config.
 *
 * The app id may be carried outright — Meta prints it on the app dashboard and
 * it travels in every authorize URL. The **secret** is only ever named: a
 * secret written into a settings document rides every read of it back to the
 * browser, so this package stores the reference and resolves it through the
 * credential seam per call, which is also what lets the settings card write a
 * new secret without reading the old one.
 *
 * Each value is resolved settings-first; see `resolveAppCredential`.
 */
export const Config: z<Config> = z.object({
  account: z.string().default('default').description('Which Meta account this mount holds. Mount the plugin again with another id to hold a second account; lowercase letters, digits and hyphens.'),
  appId: z.string().default('').description('The Meta app id. Leave empty to read it from the environment variable named by appIdRef, or to let the settings card supply it.'),
  appIdRef: z.string().default('META_APP_ID').description('Name of the environment variable or credential holding the Meta app id.'),
  appSecretRef: z.string().default('META_APP_SECRET').description('Name of the environment variable or credential holding the Meta app secret.'),
  redirectUri: z.string().default('').description('One of the Valid OAuth Redirect URIs configured on the Meta app. Sign-in is impossible without it.'),
  instagram: z.boolean().default(true).description('Ask for the Instagram permissions and offer Instagram targets for Pages that have a linked professional account.'),
  publicMediaBaseUrl: z.string().default('').description('Base URL that local media files are served under. Instagram fetches media from a public URL and cannot take an upload, so posting a local file to Instagram needs this.'),
  graphVersion: z.string().default('v25.0').description('Graph API version every call is made against.'),
  graphBaseUrl: z.string().default('https://graph.facebook.com').description('Origin of the Graph API.'),
  graphVideoBaseUrl: z.string().default('https://graph-video.facebook.com').description('Origin of the host an uploaded video is published through.'),
  loginBaseUrl: z.string().default('https://www.facebook.com').description('Origin of the login dialog the human is sent to.'),
  timeoutMs: z.natural().min(1000).default(30_000).description('Milliseconds one Graph call may take before it is abandoned.'),
  containerPollIntervalMs: z.natural().min(100).default(3000).description('Milliseconds between checks on an Instagram media container.'),
  containerTimeoutMs: z.natural().min(1000).default(300_000).description('Milliseconds to wait for an Instagram container to finish processing before reporting a timeout. Nothing is published when this runs out.'),
  tokenExpiryWarningDays: z.natural().default(14).description('How many days before the long-lived user token expires that targets start carrying a warning.'),
})

/**
 * Mount the `facebook` and `instagram` providers and their shared authorization flow.
 * @param ctx - the plugin context, injecting `social`, `credentials`, and `authorization`.
 * @param config - validated composition config.
 * @throws when `account` cannot address a credential record, which is a
 * composition error and so is refused at load rather than at the first post.
 */
/**
 * The settings namespace this plugin serves, so the application credentials can
 * be entered in Settings → Plugins → Social instead of only at deploy time.
 */
const SETTINGS_NS = 'social-meta'

/** The Meta application fields a person can edit from the settings card. */
export interface AppSettings {
  /** The app id, which Meta prints on the app dashboard. */
  appId?: string
  /** Name of the environment variable or credential record holding the app secret. */
  appSecretEnv?: string
  /** One of the Valid OAuth Redirect URIs configured on the app. */
  redirectUri?: string
  /** Base URL local media is served under, which Instagram needs to fetch a local file. */
  publicMediaBaseUrl?: string
}

/**
 * Schema for {@link SETTINGS_NS}.
 *
 * There is no app-secret field, deliberately: this section names the
 * *reference* and the card writes the secret through the credentials domain,
 * which never reads one back.
 */
const APP_SETTINGS_SCHEMA: z<AppSettings> = z.object({
  appId: z.string().description('The Meta app id, from the app dashboard. Not a secret — it travels in every authorize URL.'),
  appSecretEnv: z.string().description('Name of the environment variable holding the app secret. The secret itself is written through the credential store, never into this document.'),
  redirectUri: z.string().description('One of the Valid OAuth Redirect URIs configured on the Meta app. Sign-in is impossible without it.'),
  publicMediaBaseUrl: z.string().description('Base URL that local media files are served under. Instagram fetches media from a public URL and cannot take an upload, so posting a local file to Instagram needs this.'),
})

/**
 * Serve the settings namespace and return a live read of it.
 *
 * Awaited in a scope rather than sampled with `ctx.get`: the settings service
 * is file-backed and resolves after a plugin composed alongside it applies.
 * Absent settings is a supported composition, so it stays out of `inject`.
 *
 * @param ctx - the plugin context.
 * @param config - validated composition config, seeding the section's base.
 * @returns a read of the current section, empty until the service arrives.
 */
function installAppSettings(ctx: Context, config: Config): () => AppSettings {
  let read: () => AppSettings = () => ({})
  ctx.inject(['settings'], (settingsCtx: Context) => {
    const scope = settingsCtx.settings.register(SETTINGS_NS, APP_SETTINGS_SCHEMA, {
      base: {
        appId: config.appId,
        appSecretEnv: config.appSecretRef,
        redirectUri: config.redirectUri,
        publicMediaBaseUrl: config.publicMediaBaseUrl,
      },
    })
    read = () => scope.get()
  })
  return () => read()
}

export function apply(ctx: Context, config: Config): void {
  if (!isCredentialKeySegment(config.account)) {
    throw new Error(`social-meta: account "${config.account}" must be lowercase letters, digits and hyphens`)
  }
  const key = credentialKey(name, config.account)
  const endpoint: GraphEndpoint = {
    base: config.graphBaseUrl,
    videoBase: config.graphVideoBaseUrl,
    version: config.graphVersion,
    timeoutMs: config.timeoutMs,
  }
  // Resolved per operation, never captured: the credential seam's rule is that
  // an edited secret reaches the next operation without a restart.
  const readSettings = installAppSettings(ctx, config)
  const resolve = async (ref: string): Promise<string | undefined> =>
    (await ctx.credentials.resolve(credentialRef(ref)))?.value
  const appId = (): Promise<string> => resolveAppCredential(
    { settings: readSettings().appId, config: config.appId, ref: config.appIdRef },
    { platform: 'Meta', what: 'app id' }, resolve)
  // The secret is never a literal in any layer: it is addressed by reference
  // and read through the credential seam, which is what the settings card
  // writes into without ever reading it back.
  const appSecret = (): Promise<string> => resolveAppCredential(
    { ref: firstConfigured(readSettings().appSecretEnv, config.appSecretRef) },
    { platform: 'Meta', what: 'app secret' }, resolve)

  const providers = createMetaProviders({
    endpoint,
    credentials: ctx.credentials,
    key,
    instagram: config.instagram,
    publicMediaBaseUrl: () => firstConfigured(readSettings().publicMediaBaseUrl, config.publicMediaBaseUrl) ?? '',
    pollIntervalMs: config.containerPollIntervalMs,
    pollTimeoutMs: config.containerTimeoutMs,
    expiryWarningDays: config.tokenExpiryWarningDays,
    appId,
  })
  const flow = metaAuthorizationFlow({
    endpoint,
    loginBase: config.loginBaseUrl,
    credentials: ctx.credentials,
    key,
    label: `Meta (${config.account})`,
    instagram: config.instagram,
    redirectUri: () => firstConfigured(readSettings().redirectUri, config.redirectUri) ?? '',
    appId,
    appSecret,
  })

  ctx.effect(() => ctx.authorization.registerFlow(flow), `social-meta: authorize ${key}`)
  for (const provider of providers) {
    ctx.effect(() => ctx.social.register(provider), `social-meta: ${provider.name} provider`)
  }
}
