/**
 * The WhatsApp delegate card: whether it is working, the drafts waiting for the owner's OK with Send, Edit and Drop,
 * one form per contact (name, numbers, project, notes, on and pause switches), what it did recently, and its
 * settings and models. The form stages the plugin's contacts array; the page's Save writes it.
 */

import { useId, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Button, SettingsForm, SettingsSecretField, SettingsValueField, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import { ScoutModelPicker } from './ScoutModelPicker.tsx'
import {
  WAD_MODEL_PAIRS, WAD_NUMBER_FIELDS, type WadApproval, type WadCardFace, type WadContactStatus, type WadLiveState,
} from './whatsapp-delegate-card-controller.ts'
import { contactIssues, newContact, readContacts, renamedContact, writeContacts, type DelegateContactDraft } from './whatsapp-delegate-model.ts'
import css from './seo.module.css'

/** Props the renderer binds for the card. */
export type WhatsAppDelegateCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.operations'>
  & InjectFace<WadCardFace>

type Translate = WhatsAppDelegateCardProps['t']

function when(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 16).replace('T', ' ')
}

/**
 * Whether the delegate is working, what is missing, and the pause and check buttons.
 * @returns the block.
 */
function StatusBlock(props: {
  t: Translate
  live: WadLiveState
  onPause: () => void
  onResume: () => void
  onCheck: () => void
  onRefresh: () => void
}) {
  const { t, live } = props
  const status = live.status
  if (status === undefined) return <p className={css.hint} role="status">{live.failed ? t('wadStatusUnknown') : t('wadStatusLoading')}</p>
  const state = !status.enabled ? t('wadOff') : status.paused === null ? t('wadWorking') : t('wadPaused', { reason: status.paused.reason })
  return (
    <div className={css.field}>
      <p className={status.enabled && status.paused === null ? css.ok : css.state} role="status">{state}</p>
      {status.whatsapp ? null : <p className={css.error}>{t('wadNoWhatsApp')}</p>}
      {status.notifyTo ? null : <p className={css.error}>{t('wadNoOwnerChat')}</p>}
      {status.groqKey ? null : <p className={css.hint}>{t('wadNoGroq')}</p>}
      <div className={css.row}>
        {status.paused === null
          ? <Button variant="outline" size="sm" onClick={props.onPause}>{t('wadPauseAll')}</Button>
          : <Button variant="outline" size="sm" onClick={props.onResume}>{t('wadResume')}</Button>}
        <Button variant="ghost" size="sm" disabled={!status.enabled || status.paused !== null} onClick={props.onCheck}>{t('wadCheckNow')}</Button>
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>{t('wadRefresh')}</Button>
      </div>
      {status.contacts.map(c => <p key={c.id} className={css.hint}>{contactLine(t, c)}</p>)}
    </div>
  )
}

function contactLine(t: Translate, c: WadContactStatus): string {
  if (!c.enabled) return t('wadContactOff', { name: c.name })
  if (c.paused) return t('wadContactPaused', { name: c.name })
  if (c.working) return t('wadContactWorking', { name: c.name })
  if (c.waiting > 0) return t('wadContactWaiting', { name: c.name, n: c.waiting })
  return t('wadContactIdle', { name: c.name })
}

/**
 * One draft waiting for the owner, with Send, Edit and Drop.
 * @returns the draft's card.
 */
function ApprovalItem(props: { t: Translate; approval: WadApproval; live: WadLiveState; onDecide: WadCardFace['decide'] }) {
  const { t, approval, live } = props
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const id = useId()
  const busy = live.busy.includes(approval.code)
  return (
    <div className={css.card}>
      <p className={css.state}><strong>{t('wadDraft', { code: approval.code, name: approval.contact })}</strong>{` · ${when(approval.createdAt)}`}</p>
      {editing === undefined
        ? <p className={css.answer}>{approval.text}</p>
        : (
          <div className={css.field}>
            <label className={css.label} htmlFor={id}>{t('wadEditLabel')}</label>
            <textarea id={id} className={`${css.input} ${css.textarea}`} rows={4} value={editing} onChange={(event) => { setEditing(event.target.value) }} />
          </div>
        )}
      <p className={css.hint}>{t('wadWhy', { why: approval.why })}</p>
      <div className={css.row}>
        {editing === undefined
          ? (
            <>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => { props.onDecide(approval.code, 'approve') }}>{t('wadSend')}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setEditing(approval.text) }}>{t('wadEdit')}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { props.onDecide(approval.code, 'reject') }}>{t('wadDrop')}</Button>
            </>
          )
          : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || editing.trim() === ''}
                onClick={() => { props.onDecide(approval.code, 'edit', editing); setEditing(undefined) }}
              >
                {t('wadSendEdited')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(undefined) }}>{t('wadCancel')}</Button>
            </>
          )}
      </div>
      {live.results[approval.code] === undefined ? null : <p className={css.hint} role="status">{live.results[approval.code]}</p>}
    </div>
  )
}

/** Props of {@link ContactForm}. */
export interface ContactFormProps {
  t: Translate
  contact: DelegateContactDraft
  others: readonly DelegateContactDraft[]
  savedIds: ReadonlySet<string>
  disabled: boolean
  onChange: (next: DelegateContactDraft) => void
  onRemove: () => void
}

/**
 * One contact's form.
 * @returns the card.
 */
export function ContactForm(props: ContactFormProps) {
  const { t, contact, disabled } = props
  const base = useId()
  const set = (change: Partial<DelegateContactDraft>): void => { props.onChange({ ...contact, ...change }) }
  const issues = contactIssues(contact, props.others)
  const otherIds = new Set(props.others.map(other => other.id))
  const text = (field: 'workspacePath' | 'repoUrl' | 'deployBranch' | 'liveUrl') => (
    <div className={css.field}>
      <label className={css.label} htmlFor={`${base}-${field}`}>{t(`wadContact.${field}`)}</label>
      <input
        id={`${base}-${field}`}
        className={css.input}
        type="text"
        value={contact[field]}
        placeholder={t(`wadContact.${field}.placeholder`)}
        disabled={disabled}
        onChange={(event) => { set({ [field]: event.target.value }) }}
      />
    </div>
  )
  return (
    <div className={css.card}>
      <div className={css.formHead}>
        <h4 className={css.cardTitle}><strong>{contact.name.trim() === '' ? t('wadNewContact') : contact.name}</strong></h4>
        <Switch label={t('wadContact.enabled')} title={t('wadContact.enabled')} checked={contact.enabled} disabled={disabled} onChange={(next) => { set({ enabled: next }) }} />
      </div>
      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-name`}>{t('wadContact.name')}</label>
        <input
          id={`${base}-name`}
          className={css.input}
          type="text"
          value={contact.name}
          disabled={disabled}
          onChange={(event) => { props.onChange(renamedContact(contact, event.target.value, props.savedIds, otherIds)) }}
        />
      </div>
      <fieldset className={css.fieldset}>
        <legend className={css.label}>{t('wadContact.numbers')}</legend>
        {contact.numbers.map((number, index) => (
          <div key={index} className={css.row}>
            <input
              className={`${css.input} ${css.grow}`}
              type="tel"
              inputMode="tel"
              aria-label={t('wadContact.numbers')}
              value={number}
              placeholder={t('wadContact.number.placeholder')}
              disabled={disabled}
              onChange={(event) => { set({ numbers: contact.numbers.map((n, i) => i === index ? event.target.value : n) }) }}
            />
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { set({ numbers: contact.numbers.filter((_, i) => i !== index) }) }}>
              {t('wadRemoveNumber')}
            </Button>
          </div>
        ))}
        <div className={css.row}>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { set({ numbers: [...contact.numbers, ''] }) }}>{t('wadAddNumber')}</Button>
        </div>
        <p className={css.hint}>{t('wadContact.numbers.hint')}</p>
      </fieldset>
      <div className={css.field}>
        <label className={css.label} htmlFor={`${base}-notes`}>{t('wadContact.notes')}</label>
        <textarea
          id={`${base}-notes`}
          className={`${css.input} ${css.textarea}`}
          rows={4}
          value={contact.notes}
          placeholder={t('wadContact.notes.placeholder')}
          disabled={disabled}
          onChange={(event) => { set({ notes: event.target.value }) }}
        />
      </div>
      {text('workspacePath')}
      {text('repoUrl')}
      {text('deployBranch')}
      {text('liveUrl')}
      <p className={css.hint}>{t('wadContact.project.hint')}</p>
      <div className={css.row}>
        <Switch label={t('wadContact.paused')} title={t('wadContact.paused.hint')} checked={contact.paused} disabled={disabled} onChange={(next) => { set({ paused: next }) }} />
        <span className={css.hint}>{t('wadContact.paused.hint')}</span>
      </div>
      {issues.map(issue => (
        <p key={`${issue.key}-${String(issue.params?.['n'] ?? '')}`} className={css.error} role="alert">{t(issue.key, issue.params)}</p>
      ))}
      <div className={css.row}>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={props.onRemove}>{t('wadRemoveContact')}</Button>
      </div>
    </div>
  )
}

/**
 * The recent batches: what came in, what the delegate decided, what it sent.
 * @returns the block.
 */
function RecentBlock(props: { t: Translate; live: WadLiveState }) {
  const { t, live } = props
  const batches = live.status?.batches ?? []
  const [showLog, setShowLog] = useState(false)
  return (
    <div className={css.field}>
      {batches.length === 0 ? <p className={css.hint}>{t('wadNoActivity')}</p> : null}
      {batches.slice(0, 15).map(b => (
        <div key={b.id} className={css.card}>
          <p className={css.state}><strong>{b.contact}</strong>{` · ${when(b.startedAt)} · ${t(`wadBatch.${b.status}`)}`}</p>
          {b.messages.slice(0, 5).map((m, i) => <p key={i} className={css.hint}>{`“${m}”`}</p>)}
          {b.messages.length > 5 ? <p className={css.hint}>{t('wadMore', { n: b.messages.length - 5 })}</p> : null}
          {b.actions.map((a, i) => (
            <p key={i} className={a.kind === 'refused' ? css.error : css.answer}>
              {`${t(`wadAction.${a.kind}`, { code: a.code ?? 0 })}: ${a.text}`}
            </p>
          ))}
          {b.error === null ? null : <p className={css.error}>{b.error}</p>}
        </div>
      ))}
      <div className={css.row}>
        <Button variant="ghost" size="sm" onClick={() => { setShowLog(!showLog) }}>{showLog ? t('wadHideLog') : t('wadShowLog')}</Button>
      </div>
      {showLog ? (live.status?.activity ?? []).slice(0, 60).map((a, i) => <p key={i} className={css.hint}>{`${when(a.at)} · ${a.text}`}</p>) : null}
    </div>
  )
}

/**
 * Render the card.
 * @param props - locale copy, the form, the status and the actions.
 * @returns the summary line or the card.
 */
export function WhatsAppDelegateCard(props: WhatsAppDelegateCardProps) {
  const { t } = props
  const state = props.useWadCard(snapshot => snapshot)
  const models = props.useWadModels(snapshot => snapshot)
  const live = props.useWadLive(snapshot => snapshot)
  if (props.view === 'summary') return t('wadDescription')
  const disabled = !state.writable
  const contacts = readContacts(state.contacts.text)
  const savedIds = new Set(live.status?.contacts.map(c => c.id) ?? [])
  const stage = (next: readonly DelegateContactDraft[]): void => { props.edit('contacts', writeContacts(next)) }
  const pending = (live.status?.approvals ?? []).filter(a => a.status === 'pending')
  const common = (field: string) => ({
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('wadInvalid'),
    disabled,
    onReset: () => { props.resetField(field) },
    onEdit: (text: string) => { props.edit(field, text) },
  })
  const toggle = (field: 'enabled' | 'digest') => (
    <div className={css.field}>
      <Switch
        label={t(`wad.${field}`)}
        title={t(`wad.${field}.hint`)}
        checked={state.switches[field].text === 'true'}
        disabled={disabled}
        onChange={(next) => { props.edit(field, next ? 'true' : 'false') }}
      />
      <p className={css.hint}>{t(`wad.${field}.hint`)}</p>
    </div>
  )
  const text = (field: 'notifyTo' | 'timeZone' | 'transcriptionModel') => (
    <SettingsValueField id={`plugin-config-wad-${field}`} label={t(`wad.${field}`)} hint={t(`wad.${field}.hint`)} {...state.strings[field]} {...common(field)} />
  )
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <StatusBlock
        t={t}
        live={live}
        onPause={props.pause}
        onResume={props.resume}
        onCheck={props.checkNow}
        onRefresh={props.refreshStatus}
      />
      {toggle('enabled')}

      <h4 className={css.subtitle}>{t('wadApprovals')}</h4>
      {pending.length === 0 ? <p className={css.hint}>{t('wadNoApprovals')}</p> : null}
      {pending.map(a => <ApprovalItem key={a.code} t={t} approval={a} live={live} onDecide={props.decide} />)}

      <h4 className={css.subtitle}>{t('wadContacts')}</h4>
      {contacts.length === 0 ? <p className={css.hint}>{t('wadNoContacts')}</p> : null}
      {contacts.map((contact, index) => (
        <ContactForm
          key={index}
          t={t}
          contact={contact}
          others={contacts.filter((_, i) => i !== index)}
          savedIds={savedIds}
          disabled={disabled}
          onChange={(next) => { stage(contacts.map((c, i) => i === index ? next : c)) }}
          onRemove={() => {
            if (window.confirm(t('wadConfirmRemove', { name: contact.name.trim() === '' ? t('wadNewContact') : contact.name }))) {
              stage(contacts.filter((_, i) => i !== index))
            }
          }}
        />
      ))}
      <div className={css.row}>
        <Button variant="outline" size="sm" disabled={disabled} onClick={() => { stage([...contacts, newContact(new Set(contacts.map(c => c.id)))]) }}>
          {t('wadAddContact')}
        </Button>
      </div>

      <h4 className={css.subtitle}>{t('wadRecent')}</h4>
      <RecentBlock t={t} live={live} />

      <h4 className={css.subtitle}>{t('wadSettings')}</h4>
      {text('notifyTo')}
      {text('timeZone')}
      {toggle('digest')}
      {WAD_NUMBER_FIELDS.map(field => (
        <SettingsValueField
          key={field}
          id={`plugin-config-wad-${field}`}
          label={t(`wad.${field}`)}
          hint={t(`wad.${field}.hint`)}
          numeric
          {...state.numbers[field]}
          {...common(field)}
        />
      ))}
      <SettingsSecretField
        id="plugin-config-wad-groqApiKey"
        label={t('wad.groqApiKey')}
        hint={t('wad.groqApiKey.hint')}
        disabled={disabled}
        text={state.groqApiKey.text}
        configured={live.status?.groqKeySource === 'settings'}
        stateLabel={live.status?.groqKeySource === 'settings' ? t('scoutSecretSet') : live.status?.groqKeySource === 'environment' ? t('wadGroqFromEnv') : t('scoutSecretUnset')}
        onEdit={(value) => { props.edit('groqApiKey', value) }}
      />
      {text('transcriptionModel')}
      {WAD_MODEL_PAIRS.map(pair => (
        <ScoutModelPicker
          key={pair.key}
          labels={{
            label: t(`wad.${pair.key}`),
            hint: t(`wad.${pair.key}.hint`),
            search: t('scoutModelSearch'),
            none: t(`wad.${pair.key}.none`),
            change: t('scoutModelChange'),
            loading: t('scoutModelLoading'),
            failed: t('scoutModelFailed'),
            retry: t('scoutModelRetry'),
            noMatch: t('scoutModelNoMatch'),
            unknown: t('scoutModelUnknown'),
          }}
          catalog={models}
          provider={state.strings[pair.provider].text}
          model={state.strings[pair.model].text}
          disabled={disabled}
          onPick={(provider, model) => { props.edit(pair.provider, provider); props.edit(pair.model, model) }}
          onRetry={props.retryModels}
        />
      ))}
    </SettingsForm>
  )
}
