/** The Klipara Scout card's staged form over the `klipara-scout` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'
import {
  SettingsFormModel, settingsNumberField, settingsTextField,
  type SettingsFieldSpec, type SettingsFieldState, type SettingsFormActions, type SettingsFormScope, type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the Klipara Scout plugin, spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const SCOUT_NS = 'klipara-scout'

/** Text fields, in the order the card shows them. */
export const SCOUT_TEXT_FIELDS = [
  'shiftTime', 'timeZone', 'kliparaApiKey', 'notifyTo', 'outreachBrowser', 'provider', 'model', 'fallbackProvider', 'fallbackModel', 'sampleBaseUrl', 'sampleHeadline', 'sampleNote',
] as const
/** Whole-number fields, in the order the card shows them. */
export const SCOUT_NUMBER_FIELDS = ['samplesPerDay', 'pitchesPerDay', 'replyCheckMinutes', 'sampleTtlDays', 'minSubscribers', 'maxSubscribers', 'maxShorts'] as const

/** On/off fields, in the order the card shows them. */
export const SCOUT_SWITCH_FIELDS = ['enabled', 'fallbackPitches'] as const

/** Provider and model pairs the card sets through a model picker rather than as text. */
export const SCOUT_MODEL_PAIRS = [
  { key: 'shiftModel', provider: 'provider', model: 'model' },
  { key: 'fallbackModelPick', provider: 'fallbackProvider', model: 'fallbackModel' },
] as const
/** The API key, shown masked. */
export const SCOUT_KEY_FIELD = 'kliparaApiKey'

type ScoutTextField = typeof SCOUT_TEXT_FIELDS[number]
type ScoutSwitchField = typeof SCOUT_SWITCH_FIELDS[number]
type ScoutNumberField = typeof SCOUT_NUMBER_FIELDS[number]

/** The Klipara Scout fields this card edits. */
export type ScoutSettings = Partial<Record<ScoutTextField | ScoutNumberField | ScoutSwitchField | 'topics', unknown>>

/** What the Klipara Scout card renders. */
export interface ScoutCardState extends SettingsFormShell {
  switches: Record<ScoutSwitchField, SettingsFieldState>
  topics: SettingsFieldState
  text: Record<ScoutTextField, SettingsFieldState>
  numbers: Record<ScoutNumberField, SettingsFieldState>
}

/** The registration-side face the card's slot entry injects. */
export interface ScoutCardFace extends SettingsFormActions {
  /** Open the separate Klipara Scout leads page. */
  openLeads: () => void
  /** Load the model catalog again after a failure. */
  retryModels: () => void
  hooks: {
    /** Card snapshot bound by the renderer as useScoutCard. */
    scoutCard: SnapshotStore<ScoutCardState>
    /** Model catalog bound by the renderer as useScoutModels. */
    scoutModels: SnapshotStore<ScoutModelCatalogState>
  }
}

/**
 * An on/off switch, staged as the text `true` or `false`.
 * @param field - the setting.
 * @returns the field spec.
 */
function switchField(field: ScoutSwitchField): SettingsFieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * The search topics, one per line.
 * @returns the field spec.
 */
function topicsField(): SettingsFieldSpec {
  return {
    field: 'topics',
    format: value => Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : '',
    parse: (text) => {
      const topics = text.split('\n').map(line => line.trim()).filter(line => line !== '')
      return topics.length === 0 ? { kind: 'clear' } : { kind: 'set', value: topics }
    },
  }
}

/** Bridges the `klipara-scout` scope onto the card's staged form. */
export class ScoutCardController {
  private readonly form: SettingsFormModel<ScoutSettings>
  private readonly store: SnapshotStore<ScoutCardState>

  /** @param scope - the bound settings scope for the `klipara-scout` namespace. */
  constructor(scope: SettingsFormScope<ScoutSettings>) {
    this.form = new SettingsFormModel(scope, [
      ...SCOUT_SWITCH_FIELDS.map(field => switchField(field)),
      topicsField(),
      ...SCOUT_TEXT_FIELDS.map(field => settingsTextField(field)),
      ...SCOUT_NUMBER_FIELDS.map(field => settingsNumberField(field)),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ScoutCardState {
    return {
      ...this.form.shell(),
      switches: Object.fromEntries(SCOUT_SWITCH_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<ScoutSwitchField, SettingsFieldState>,
      topics: this.form.field('topics'),
      text: Object.fromEntries(SCOUT_TEXT_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<ScoutTextField, SettingsFieldState>,
      numbers: Object.fromEntries(SCOUT_NUMBER_FIELDS.map(field => [field, this.form.field(field)])) as
        Record<ScoutNumberField, SettingsFieldState>,
    }
  }

  /** Stop following the settings scope; the page is gone. */
  dispose(): void { this.form.dispose() }

  /**
   * Build the face the card's slot registration injects.
   * @param openLeads - opens the leads page.
   * @param models - the model catalog the pickers offer.
   * @param retryModels - reloads that catalog.
   * @returns the card's snapshot, its form actions, the catalog and the leads link.
   */
  inject(openLeads: () => void, models: SnapshotStore<ScoutModelCatalogState>, retryModels: () => void): ScoutCardFace {
    return { hooks: { scoutCard: this.store, scoutModels: models }, ...this.form.actions(), openLeads, retryModels }
  }
}
