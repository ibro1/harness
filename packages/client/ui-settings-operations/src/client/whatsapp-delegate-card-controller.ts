/**
 * The WhatsApp delegate card's staged form over the `whatsapp-delegate`
 * settings namespace, plus the Host's routes: `/whatsapp-delegate/status`
 * (contacts at work, drafts waiting for the owner, recent batches and the
 * activity log) and `/whatsapp-delegate/action` (pause, resume, check now,
 * and approve, edit or reject a draft). The contacts form stages the
 * `contacts` array as JSON text; the Groq key is a `role('secret')` field,
 * written blind.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'
import { contactIssues, readContacts } from './whatsapp-delegate-model.ts'

/** Namespace of the WhatsApp delegate plugin; a client package must not import a Host package. */
export const WAD_NS = 'whatsapp-delegate'
/** Where the plugin's routes are mounted. */
const ROUTE = '/whatsapp-delegate'

/** Text fields, in the order the card shows them. */
export const WAD_STRING_FIELDS = ['notifyTo', 'timeZone', 'provider', 'model', 'fallbackProvider', 'fallbackModel', 'transcriptionModel'] as const
/** Whole-number fields. */
export const WAD_NUMBER_FIELDS = [
  'quietSeconds', 'maxWaitSeconds', 'ownerActiveMinutes', 'maxReplies', 'rateWindowMinutes', 'contextMessages', 'maxReplyChars', 'pollSeconds',
  'fallbackCooldownMinutes',
] as const
/** On/off fields. */
export const WAD_SWITCH_FIELDS = ['enabled', 'digest'] as const
/** Provider and model pairs set through a model picker. */
export const WAD_MODEL_PAIRS = [
  { key: 'model', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
] as const

type StringField = typeof WAD_STRING_FIELDS[number]
type NumberField = typeof WAD_NUMBER_FIELDS[number]
type SwitchField = typeof WAD_SWITCH_FIELDS[number]

/** The fields this card edits. */
export type WadSettings = Partial<Record<StringField | NumberField | SwitchField | 'contacts' | 'groqApiKey', unknown>>

/** One contact's state, as `/whatsapp-delegate/status` lists it. */
export interface WadContactStatus {
  id: string
  name: string
  enabled: boolean
  paused: boolean
  sessionId: string | null
  /** Messages read and waiting for the burst to end. */
  waiting: number
  /** A batch is with the Session now. */
  working: boolean
}

/** One draft for the owner. */
export interface WadApproval {
  code: number
  contact: string
  text: string
  why: string
  createdAt: string
  status: 'pending' | 'sent' | 'rejected' | 'failed'
  decidedAt: string | null
  outcome: string | null
}

/** One batch handed to a Session. */
export interface WadBatch {
  id: string
  contact: string
  startedAt: string
  endedAt: string | null
  status: 'running' | 'done' | 'handed-off' | 'failed' | 'interrupted'
  messages: string[]
  error: string | null
  actions: { kind: 'reply' | 'queued' | 'no-reply' | 'tell-owner' | 'refused'; text: string; code: number | null }[]
}

/** `/whatsapp-delegate/status`. */
export interface WadStatus {
  enabled: boolean
  paused: { reason: string; at: string } | null
  whatsapp: boolean
  notifyTo: boolean
  groqKey: boolean
  groqKeySource: 'settings' | 'environment' | 'none'
  contacts: WadContactStatus[]
  approvals: WadApproval[]
  batches: WadBatch[]
  activity: { at: string; contactId: string; kind: string; text: string }[]
}

/** The status block's state. */
export interface WadLiveState {
  status: WadStatus | undefined
  failed: boolean
  /** Draft numbers with a decision in flight. */
  busy: number[]
  /** What the last decision on each draft answered. */
  results: Record<number, string>
}

/** What the card renders. */
export interface WadCardState extends SettingsFormShell {
  contacts: SettingsFieldState
  strings: Record<StringField, SettingsFieldState>
  numbers: Record<NumberField, SettingsFieldState>
  switches: Record<SwitchField, SettingsFieldState>
  groqApiKey: SettingsFieldState
}

/** The face the card's slot entry injects. */
export interface WadCardFace extends SettingsFormActions {
  retryModels: () => void
  refreshStatus: () => void
  /** Pause or resume everything at once, without Save. */
  pause: () => void
  resume: () => void
  /** Read the chats now instead of at the next poll. */
  checkNow: () => void
  /** Send, send an edited text, or drop a draft. */
  decide: (code: number, decision: 'approve' | 'edit' | 'reject', text?: string) => void
  hooks: {
    /** Bound as useWadCard. */
    wadCard: SnapshotStore<WadCardState>
    /** Bound as useWadModels. */
    wadModels: SnapshotStore<ScoutModelCatalogState>
    /** Bound as useWadLive. */
    wadLive: SnapshotStore<WadLiveState>
  }
}

function switchField(field: SwitchField): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * The contacts as pretty-printed JSON. A draft that is not a JSON array of objects, or holds a contact the form
 * reports a problem with, blocks the save.
 * @returns the field spec.
 */
export function contactsField(): SettingsFieldSpec {
  return {
    field: 'contacts',
    format: value => JSON.stringify(Array.isArray(value) ? value : [], null, 2),
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' }
      try {
        const value: unknown = JSON.parse(text)
        if (!Array.isArray(value) || !value.every(entry => typeof entry === 'object' && entry !== null && !Array.isArray(entry))) return undefined
        const contacts = readContacts(text)
        return contacts.every((contact, i) => contactIssues(contact, contacts.filter((_, j) => j !== i)).length === 0)
          ? { kind: 'set', value }
          : undefined
      } catch {
        // Not JSON; only this form stages the field, so the save waits.
        return undefined
      }
    },
  }
}

/** Bridges the settings scope onto the card, and calls the Host's routes. */
export class WadCardController {
  private readonly form: SettingsFormModel<WadSettings>
  private readonly store: SnapshotStore<WadCardState>
  private readonly live = createSnapshotStore<WadLiveState>({ status: undefined, failed: false, busy: [], results: {} })

  /**
   * @param scope - the bound settings scope.
   * @param request - same-origin HTTP, injectable for tests.
   */
  constructor(
    scope: SettingsFormScope<WadSettings>,
    private readonly request: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    this.form = new SettingsFormModel(scope, [
      contactsField(),
      ...WAD_SWITCH_FIELDS.map(field => switchField(field)),
      ...WAD_STRING_FIELDS.map(field => settingsTextField(field)),
      ...WAD_NUMBER_FIELDS.map(field => settingsNumberField(field)),
    ], [{
      field: 'groqApiKey',
      write: async (text: string) => {
        const accepted = await scope.mutate([{ op: 'set', path: ['groqApiKey'], value: text.trim() }])
        this.refreshStatus()
        return accepted
      },
    }])
    const fields = <F extends string>(names: readonly F[]): Record<F, SettingsFieldState> =>
      Object.fromEntries(names.map(field => [field, this.form.field(field)])) as Record<F, SettingsFieldState>
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      contacts: this.form.field('contacts'),
      strings: fields(WAD_STRING_FIELDS),
      numbers: fields(WAD_NUMBER_FIELDS),
      switches: fields(WAD_SWITCH_FIELDS),
      groqApiKey: this.form.field('groqApiKey'),
    }))
  }

  /** Read `/whatsapp-delegate/status`. */
  refreshStatus(): void {
    void (async () => {
      try {
        const response = await this.request(`${ROUTE}/status`, { cache: 'no-store', credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const status = await response.json() as WadStatus
        this.live.update((draft) => { draft.status = status; draft.failed = false })
      } catch {
        // The plugin is not loaded or the sign-in expired: the card says the status is unknown.
        this.live.update((draft) => { draft.failed = true })
      }
    })()
  }

  private async act(body: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    try {
      const response = await this.request(`${ROUTE}/action`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const answer = await response.json() as { outcome?: unknown; error?: unknown }
      const text = typeof answer.outcome === 'string' ? answer.outcome : typeof answer.error === 'string' ? answer.error : String(response.status)
      return { ok: response.ok, text }
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Decide on a draft and record what the route answered.
   * @param code - the draft's number.
   * @param decision - send it, send an edited text, or drop it.
   * @param text - the edited text.
   */
  decide(code: number, decision: 'approve' | 'edit' | 'reject', text?: string): void {
    this.live.update((draft) => { draft.busy.push(code) })
    void this.act({ action: decision, code, ...text === undefined ? {} : { text } }).then((answer) => {
      this.live.update((draft) => {
        draft.busy = draft.busy.filter(c => c !== code)
        draft.results[code] = answer.text
      })
      this.refreshStatus()
    })
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void {
    this.form.dispose()
  }

  /**
   * Build the face the card's slot registration injects, reading the status as the page opens.
   * @param models - the model catalog the pickers offer.
   * @param retryModels - reloads that catalog.
   * @returns the card's snapshots and actions.
   */
  inject(models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): WadCardFace {
    this.refreshStatus()
    const actions = this.form.actions()
    const simple = (action: 'pause' | 'resume' | 'poll'): void => {
      void this.act({ action }).then(() => { setTimeout(() => { this.refreshStatus() }, action === 'poll' ? 3000 : 0) })
    }
    return {
      hooks: { wadCard: this.store, wadModels: models, wadLive: this.live },
      ...actions,
      save: () => { actions.save(); setTimeout(() => { this.refreshStatus() }, 1500) },
      retryModels,
      refreshStatus: () => { this.refreshStatus() },
      pause: () => { simple('pause') },
      resume: () => { simple('resume') },
      checkNow: () => { simple('poll') },
      decide: (code, decision, text) => { this.decide(code, decision, text) },
    }
  }
}
