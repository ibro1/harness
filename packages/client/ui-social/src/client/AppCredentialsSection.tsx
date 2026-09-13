/**
 * The application-credential block of the social card: one form per platform
 * application, each with its public id, its redirect URI, the name its secret
 * is stored under, and a write-only box for the secret itself.
 *
 * Rendered inside the card rather than as cards of its own, because these
 * belong to the same question a person opened the card with — why can it not
 * post — and a deployment that has never set them is the commonest answer.
 */

import type { AppCredentialState, AppFieldState } from './app-credentials-controller.ts'
import type { SocialKey } from './locales.ts'
import css from './social.module.css'

/** What this section needs from the card. */
export interface AppCredentialsSectionProps {
  /** Locale reader for the social namespace. */
  t: (key: SocialKey, params?: Record<string, string>) => string
  /** The blocks, one per application, in render order. */
  blocks: readonly AppCredentialState[]
  /** Stage draft text for one field of one application's block. */
  onEdit: (application: string, field: string, text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: (application: string, field: string) => void
  /** Write one application's staged edits. */
  onSave: (application: string) => void
  /** Drop one application's staged edits. */
  onDiscard: (application: string) => void
}

/** The locale keys one application's block titles and labels come from. */
interface BlockCopy {
  /** The block heading. */
  title: SocialKey
  /** Where in the platform's console these values live. */
  hint: SocialKey
  /** Label of the public id control. */
  id: SocialKey
  /** Label of the secret control. */
  secret: SocialKey
}

/**
 * The copy keys for one application.
 *
 * A lookup rather than a computed `app${Name}Title`: the locale key set is what
 * the i18n gate checks, and keys a reader cannot grep for are keys that rot.
 * @param application - which application the block configures.
 * @returns its title, hint, and the two labels that differ by platform.
 */
function copyFor(application: string): BlockCopy {
  if (application === 'meta') {
    return { title: 'appMetaTitle', hint: 'appMetaHint', id: 'appIdMeta', secret: 'appSecretMeta' }
  }
  if (application === 'youtube') {
    return { title: 'appYoutubeTitle', hint: 'appYoutubeHint', id: 'appIdYoutube', secret: 'appSecretYoutube' }
  }
  return { title: 'appLinkedinTitle', hint: 'appLinkedinHint', id: 'appIdLinkedin', secret: 'appSecretLinkedin' }
}

/**
 * Render the application-credential forms.
 * @param props - locale copy, the blocks, and the form actions.
 * @returns the section, or nothing when no application is composed.
 */
export function AppCredentialsSection(props: AppCredentialsSectionProps) {
  const { t, blocks } = props
  // Every block of an uncomposed deployment is unavailable; showing three
  // headings over three "not composed" lines would be noise, not information.
  const shown = blocks.filter(block => block.available)
  if (shown.length === 0) return null

  return (
    <div className={css.appSection}>
      <span className={css.sectionHead}>{t('appHeading')}</span>
      <p className={css.muted}>{t('appIntro')}</p>
      {shown.map((block) => {
        const copy = copyFor(block.application)
        const disabled = !block.writable
        const field = (key: SocialKey, hint: SocialKey, name: string, state: AppFieldState) => (
          <div key={name} className={css.appField}>
            <div className={css.appFieldHead}>
              <label className={css.appLabel} htmlFor={`social-app-${block.application}-${name}`}>
                {t(key)}
              </label>
              {state.overridden && (
                <span className={css.appBadges}>
                  <span className={css.appBadge}>{t('appOverridden')}</span>
                  <button
                    type="button"
                    className={css.appReset}
                    disabled={disabled}
                    onClick={() => { props.onReset(block.application, name) }}
                  >
                    {t('appReset')}
                  </button>
                </span>
              )}
            </div>
            <input
              id={`social-app-${block.application}-${name}`}
              className={css.appInput}
              type="text"
              autoComplete="off"
              value={state.text}
              disabled={disabled}
              onChange={(event) => { props.onEdit(block.application, name, event.target.value) }}
            />
            <p className={css.muted}>{t(hint)}</p>
          </div>
        )
        return (
          <div key={block.application} className={css.appBlock}>
            <span className={css.appTitle}>{t(copy.title)}</span>
            <p className={css.muted}>{t(copy.hint)}</p>

            {field(copy.id, 'appIdHint', block.idField, block.id)}

            <div className={css.appField}>
              <div className={css.appFieldHead}>
                <label className={css.appLabel} htmlFor={`social-app-${block.application}-secret`}>
                  {t(copy.secret)}
                </label>
                <span className={css.appBadges}>
                  <span className={block.secretConfigured ? css.appBadge : css.appBadgeMuted}>
                    {t(block.secretConfigured ? 'appSecretSet' : 'appSecretUnset')}
                  </span>
                </span>
              </div>
              {/* `password`, and never seeded from a response: the value is
                  written through the credentials domain and is not readable,
                  so the box is blank even when one is configured. */}
              <input
                id={`social-app-${block.application}-secret`}
                className={css.appInput}
                type="password"
                autoComplete="off"
                value={block.secret.text}
                disabled={disabled || !block.secretWritable}
                onChange={(event) => { props.onEdit(block.application, 'secret', event.target.value) }}
              />
              <p className={css.muted}>
                {block.secretFromEnvironment
                  ? t('appSecretFromEnv', { name: block.secretRefName })
                  : t('appSecretHint')}
              </p>
            </div>

            {field('appSecretRefLabel', 'appSecretRefHint', block.secretRefField, block.secretRef)}
            {field('appRedirectLabel', 'appRedirectHint', 'redirectUri', block.redirectUri)}
            {block.publicMediaBaseUrl !== undefined
              && field('appPublicMediaLabel', 'appPublicMediaHint', 'publicMediaBaseUrl', block.publicMediaBaseUrl)}

            {disabled && <p className={css.muted}>{t('appReadOnly')}</p>}
            {block.failed && <p className={css.reason}>{t('appSaveFailed')}</p>}

            <div className={css.appActions}>
              <button
                type="button"
                className={css.primary}
                disabled={disabled || !block.dirty || block.saving}
                onClick={() => { props.onSave(block.application) }}
              >
                {t(block.saving ? 'appSaving' : 'appSave')}
              </button>
              <button
                type="button"
                className={css.secondary}
                disabled={!block.dirty || block.saving}
                onClick={() => { props.onDiscard(block.application) }}
              >
                {t('appDiscard')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
