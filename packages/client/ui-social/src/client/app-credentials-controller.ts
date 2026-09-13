/**
 * The social card's application-credential forms, one per platform application.
 *
 * These are the credentials that identify the **operator's app** to a platform
 * — a LinkedIn client id, a Meta app id, a Google OAuth client — as opposed to
 * the account token a sign-in returns, which never appears in a form at all and
 * is the credential seam's business. Before this the app credentials could only
 * be set in the deployment's environment, which meant a redeploy to correct a
 * pasted value; each provider now serves a settings namespace, and these forms
 * edit it.
 *
 * The id and the redirect URI live in the settings document. The **secret**
 * does not: a secret written into a settings section rides every read of that
 * section back to the browser and sits in the form. Each section instead names
 * the environment variable or credential record the secret lives in, and the
 * secret itself is written through the credentials domain, which reports only
 * whether one is configured and never hands one back.
 *
 * The staging model here is this package's own rather than `ui-settings-plugins`'
 * `CardForm`. Not a preference: the shell shares a fixed module table with the
 * client bundles, that package is not in it, and the bundle-purity gate refuses
 * a cross-plugin value import rather than letting it fail in a browser. The
 * behaviour is deliberately the same — edits stage, a save writes and re-seeds,
 * an empty draft clears the field — because two answers to what Save means
 * inside one settings section would be a defect whatever the module graph says.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Form field the write-only secret control stages under. */
const SECRET_FIELD = 'secret'

/**
 * One platform application the card configures.
 *
 * Spelled here rather than imported from the provider plugins: a client package
 * must not depend on a Host package, and each plugin spells the same values.
 * A fourth provider joins the card by adding an entry.
 */
export interface AppCredentialSpec {
  /** Which application this block configures; also its locale key prefix. */
  application: 'linkedin' | 'meta' | 'youtube'
  /** Settings namespace the owning plugin serves. */
  namespace: string
  /** Section field holding the public id — a client id, an app id. */
  idField: string
  /** Section field naming the variable the secret lives in. */
  secretRefField: string
  /** What that field falls back to when the section names nothing. */
  defaultSecretRef: string
  /** Whether this application has a public media base URL, which only Meta does. */
  publicMedia: boolean
}

/** The three applications this card configures, in the order they render. */
export const APP_CREDENTIAL_SPECS: readonly AppCredentialSpec[] = [
  {
    application: 'linkedin',
    namespace: 'social-linkedin',
    idField: 'clientId',
    secretRefField: 'clientSecretEnv',
    defaultSecretRef: 'LINKEDIN_CLIENT_SECRET',
    publicMedia: false,
  },
  {
    // One Meta application backs both the facebook and instagram providers, so
    // this block is named after the app rather than after either provider.
    application: 'meta',
    namespace: 'social-meta',
    idField: 'appId',
    secretRefField: 'appSecretEnv',
    defaultSecretRef: 'META_APP_SECRET',
    publicMedia: true,
  },
  {
    application: 'youtube',
    namespace: 'social-youtube',
    idField: 'clientId',
    secretRefField: 'clientSecretEnv',
    defaultSecretRef: 'GOOGLE_CLIENT_SECRET',
    publicMedia: false,
  },
]

/** The section fields one application's form edits. */
interface AppSection {
  /** The public id — a client id or an app id. */
  clientId?: string
  /** The Meta spelling of the same thing. */
  appId?: string
  /** Name of the variable the secret lives in. */
  clientSecretEnv?: string
  /** The Meta spelling of the same thing. */
  appSecretEnv?: string
  /** The redirect URI registered on the application. */
  redirectUri?: string
  /** Base URL local media is served under; Meta only. */
  publicMediaBaseUrl?: string
}

/** One control as the card renders it. */
export interface AppFieldState {
  /** Draft text the control renders. */
  text: string
  /**
   * Whether saving would leave a user-layer entry for this field. A staged edit
   * answers for itself, so the badge previews the save rather than reporting a
   * state the pending edit already contradicts.
   */
  overridden: boolean
}

/** One application's block as the card renders it. */
export interface AppCredentialState {
  /** False while the namespace is not served to this client; the block is not rendered. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /**
   * Whether the block holds edits that a save would write.
   *
   * There is no companion `invalid`: every control here is free text, an empty
   * draft clears the field, and any other draft is a value. Nothing this form
   * can stage is a value it would refuse, so a flag for it would be a state no
   * code path reaches.
   */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land; cleared by the next edit or save. */
  failed: boolean
  /** Which application this block configures; the locale key prefix. */
  application: string
  /** Section field the public id control addresses, which Meta spells differently. */
  idField: string
  /** Section field the secret-reference control addresses. */
  secretRefField: string
  /** The public id control. */
  id: AppFieldState
  /** The redirect-URI control. */
  redirectUri: AppFieldState
  /** The public media base control, present only for Meta. */
  publicMediaBaseUrl?: AppFieldState
  /** The control naming the variable the secret lives in. */
  secretRef: AppFieldState
  /** The write-only secret control, blank on every load. */
  secret: AppFieldState
  /** Whether the Host reports a secret configured under the referenced name. */
  secretConfigured: boolean
  /** Whether the credentials domain accepts a write for it. */
  secretWritable: boolean
  /**
   * The reference the secret is addressed by, for the sentence explaining a
   * disabled control: naming `LINKEDIN_CLIENT_SECRET` is the actionable half.
   */
  secretRefName: string
  /** True when the inherited environment supplies the secret and outranks this card. */
  secretFromEnvironment: boolean
}

/** What the credentials domain last reported, and for which reference. */
interface SecretState {
  /** Reference this answer describes; a stale answer for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /**
   * Whether a write can affect it; false disables the control.
   *
   * The one layer that reports false is the inherited process environment,
   * which outranks the store this card writes to. A save there would be stored
   * and then shadowed, so the control is disabled instead — and {@link source}
   * is what lets the card say why rather than leaving a greyed box.
   */
  writable: boolean
  /** Layer currently supplying the value (`env`, `file`, a `.env` path); absent while unconfigured. */
  source?: string
}

/** One field's staged edit. */
interface StagedEdit {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/** The registration-side face the social card's slot entry injects for these forms. */
export interface SocialCredentialsFace {
  hooks: {
    /** The blocks, bound by the renderer as useSocialCredentials. */
    socialCredentials: SnapshotStore<readonly AppCredentialState[]>
  }
  /** Stage draft text for one field of one application's block. */
  editCredential: (application: string, field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetCredentialField: (application: string, field: string) => void
  /** Write every staged edit in one application's block. */
  saveCredentials: (application: string) => void
  /** Drop every staged edit in one application's block. */
  discardCredentials: (application: string) => void
}

/** Read one string field off a section, treating a non-string as absent. */
function sectionText(section: AppSection | undefined, field: string): string {
  const value = (section as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'string' ? value : ''
}

/** One application's form: its settings section, and its secret. */
class AppCredentialForm {
  private readonly staged = new Map<string, StagedEdit>()
  private secret: SecretState = { ref: '', configured: false, writable: true }
  private saving = false
  private failed = false

  /**
   * @param spec - which application this form configures.
   * @param scope - the bound settings scope for that application's namespace.
   * @param ctx - the card plugin's context, whose `remote.credentials` namespace
   * answers for the secret the section references.
   * @param changed - called whenever this form's projection moves.
   */
  constructor(
    readonly spec: AppCredentialSpec,
    private readonly scope: SettingsScope<AppSection>,
    private readonly ctx: ClientContext,
    private readonly changed: () => void,
  ) {
    scope.subscribe(() => {
      this.changed()
      void this.readSecret()
    })
    void this.readSecret()
  }

  /** The section fields this form edits, in no particular order. */
  private fields(): string[] {
    return [
      this.spec.idField,
      this.spec.secretRefField,
      'redirectUri',
      ...this.spec.publicMedia ? ['publicMediaBaseUrl'] : [],
    ]
  }

  /**
   * Project this application's block.
   * @returns the block as the card renders it.
   */
  state(): AppCredentialState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      saving: this.saving,
      failed: this.failed,
      application: this.spec.application,
      idField: this.spec.idField,
      secretRefField: this.spec.secretRefField,
      id: this.field(this.spec.idField),
      redirectUri: this.field('redirectUri'),
      ...this.spec.publicMedia ? { publicMediaBaseUrl: this.field('publicMediaBaseUrl') } : {},
      secretRef: this.field(this.spec.secretRefField),
      secret: { text: this.staged.get(SECRET_FIELD)?.text ?? '', overridden: false },
      secretConfigured: this.secret.configured,
      secretWritable: this.secret.writable,
      secretRefName: this.ref(),
      secretFromEnvironment: this.secret.source === 'env',
    }
  }

  /**
   * Read one section control's state.
   * @param field - the section field.
   * @returns its draft text and whether a save would leave an override.
   */
  private field(field: string): AppFieldState {
    const staged = this.staged.get(field)
    if (staged === undefined) {
      const snapshot = this.scope.getSnapshot()
      const stored = (snapshot.user as Record<string, unknown> | undefined)?.[field]
      return {
        text: sectionText(snapshot.value, field),
        // Presence in the user layer, not a value comparison: an override equal
        // to the composition default is still an override.
        overridden: stored !== undefined,
      }
    }
    return { text: staged.text, overridden: !staged.clear && staged.text.trim() !== '' }
  }

  /** Stage one control's draft text. */
  edit(field: string, text: string): void {
    this.staged.set(field, { text, clear: false })
    this.failed = false
    this.changed()
  }

  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  reset(field: string): void {
    const base = (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
    this.staged.set(field, { text: typeof base === 'string' ? base : '', clear: true })
    this.failed = false
    this.changed()
  }

  /** Drop every staged edit. */
  discard(): void {
    if (this.staged.size === 0 && !this.failed) return
    this.staged.clear()
    this.failed = false
    this.changed()
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   *
   * The secret goes through the credentials domain and the rest through the
   * settings scope, but they settle as one gesture: a person pressing Save on a
   * block means all of it, and reporting half a save would be worse than
   * reporting a failure.
   */
  async save(): Promise<void> {
    if (this.staged.size === 0 || this.saving) return
    this.saving = true
    this.failed = false
    this.changed()
    let landed = true
    try {
      for (const field of this.fields()) {
        const staged = this.staged.get(field)
        if (staged === undefined) continue
        const text = staged.text.trim()
        // An empty draft clears the field, so emptying a control and saving is
        // the same gesture as resetting it.
        if (staged.clear || text === '') await this.scope.unset(field)
        else await this.scope.set(field, text)
      }
      const secret = this.staged.get(SECRET_FIELD)
      // A blank secret draft writes nothing, which keeps the stored secret
      // rather than clearing it — the control cannot show what is there, so a
      // blank box must not be read as "remove it".
      if (secret !== undefined && secret.text.trim() !== '') {
        landed = await this.writeSecret(secret.text.trim())
      }
    } catch {
      landed = false
    }
    this.saving = false
    this.failed = !landed
    if (landed) this.staged.clear()
    this.changed()
    await this.readSecret()
  }

  /**
   * The reference the section names, or the plugin's default.
   * @returns the credential reference the secret control addresses.
   */
  private ref(): string {
    const declared = sectionText(this.scope.getSnapshot().value, this.spec.secretRefField)
    return declared === '' ? this.spec.defaultSecretRef : declared
  }

  /**
   * Ask the credentials domain about the reference the section currently names.
   *
   * The answer is stored with the reference it describes: the field naming it
   * can change between the request and its response, and two reads can settle
   * out of order, so an answer is published only while it still answers for the
   * reference in force.
   */
  private async readSecret(): Promise<void> {
    const ref = this.ref()
    if (ref !== this.secret.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim a
      // secret is configured under a name nobody has checked.
      this.secret = { ref, configured: false, writable: true }
      this.changed()
    }
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok || ref !== this.ref()) return
    const view = response.value[ref]
    const source = view?.source
    const next: SecretState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference stays writable: the control remains usable and the
      // Host is what refuses, rather than the card guessing a refusal.
      writable: view?.writable ?? true,
      ...source === undefined ? {} : { source },
    }
    if (next.configured === this.secret.configured
      && next.writable === this.secret.writable
      && next.source === this.secret.source) return
    this.secret = next
    this.changed()
  }

  /**
   * Write the staged secret, then re-read whether the Host now holds one.
   * @param value - the staged secret.
   * @returns whether the Host reports one configured afterwards.
   */
  private async writeSecret(value: string): Promise<boolean> {
    // Refusals surface through the re-read: the Host is the only authority on
    // whether the secret now exists.
    await this.ctx.remote.credentials.set(this.ref(), value)
    await this.readSecret()
    return this.secret.configured
  }
}

/** Bridges the three application namespaces and the credentials domain onto the card. */
export class SocialCredentialsController {
  private readonly forms: AppCredentialForm[] = []
  private readonly store: SnapshotStore<readonly AppCredentialState[]>

  /**
   * @param ctx - the card plugin's context, carrying `settingsScope` and `remote.credentials`.
   */
  constructor(ctx: ClientContext) {
    const publish = (): void => { this.store.set(this.forms.map(form => form.state())) }
    for (const spec of APP_CREDENTIAL_SPECS) {
      this.forms.push(new AppCredentialForm(
        spec,
        ctx.settingsScope.bind<AppSection>({ namespace: spec.namespace }),
        ctx,
        () => { publish() },
      ))
    }
    this.store = createSnapshotStore<readonly AppCredentialState[]>(this.forms.map(form => form.state()))
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the blocks and the per-application form actions.
   */
  inject(): SocialCredentialsFace {
    const on = (application: string): AppCredentialForm | undefined =>
      this.forms.find(form => form.spec.application === application)
    return {
      hooks: { socialCredentials: this.store },
      editCredential: (application, field, text) => { on(application)?.edit(field, text) },
      resetCredentialField: (application, field) => { on(application)?.reset(field) },
      saveCredentials: (application) => { void on(application)?.save() },
      discardCredentials: (application) => { on(application)?.discard() },
    }
  }
}
