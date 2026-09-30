/** A searchable pick of one provider and model from the Host's model catalog. */

import { useId, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScoutModelCatalogState } from './scout-model-catalog.ts'
import css from './scout.module.css'

/** Copy the picker shows. */
export interface ScoutModelPickerLabels {
  label: string
  hint: string
  search: string
  /** The choice that leaves both fields empty. */
  none: string
  change: string
  loading: string
  failed: string
  retry: string
  noMatch: string
  /** Shown when the saved pair is not in the catalog. */
  unknown: string
}

/** Props of {@link ScoutModelPicker}. */
export interface ScoutModelPickerProps {
  labels: ScoutModelPickerLabels
  catalog: ScoutModelCatalogState
  provider: string
  model: string
  disabled: boolean
  /** Stage both fields; empty strings choose {@link ScoutModelPickerLabels.none}. */
  onPick: (provider: string, model: string) => void
  onRetry: () => void
}

/**
 * Render the current choice, and on demand a filtered list of every catalog
 * model grouped by provider, so a model is chosen rather than typed.
 * @param props - copy, catalog, the staged pair and the pick action.
 * @returns the picker.
 */
export function ScoutModelPicker(props: ScoutModelPickerProps) {
  const { labels, catalog } = props
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listId = useId()
  const provider = props.provider.trim()
  const model = props.model.trim()
  const group = catalog.groups.find(g => g.id === provider)
  const entry = group?.models.find(m => m.id === model)
  const unset = provider === '' || model === ''
  const unknown = !unset && catalog.status === 'ready' && entry === undefined
  const current = unset ? labels.none : `${group?.name ?? provider} · ${entry?.name ?? model}`
  const words = query.toLowerCase().split(/\s+/u).filter(w => w !== '')
  const matches = (text: string): boolean => words.every(w => text.toLowerCase().includes(w))
  const groups = catalog.groups
    .map(g => ({ ...g, models: g.models.filter(m => matches(`${g.name} ${g.id} ${m.name} ${m.id}`)) }))
    .filter(g => g.models.length > 0)
  const pick = (nextProvider: string, nextModel: string): void => {
    props.onPick(nextProvider, nextModel)
    setOpen(false)
    setQuery('')
  }
  return (
    <div className={css.picker}>
      <div className={css.pickerHead}>
        <span className={css.pickerLabel}>{labels.label}</span>
        {unknown ? <span className={css.pickerUnknown} role="status">{labels.unknown}</span> : null}
      </div>
      <div className={css.pickerCurrent}>
        <span className={css.pickerValue}>{current}</span>
        <Button variant="outline" size="sm" disabled={props.disabled} aria-expanded={open} aria-controls={listId}
          onClick={() => { setOpen(!open) }}>{labels.change}</Button>
      </div>
      <p className={css.pickerHint}>{labels.hint}</p>
      {open
        ? (
          <div id={listId} className={css.pickerPanel}>
            <Input value={query} placeholder={labels.search} aria-label={labels.search} autoFocus
              onChange={(event) => { setQuery(event.target.value) }} />
            {catalog.status === 'loading' && catalog.groups.length === 0 ? <p className={css.pickerNote}>{labels.loading}</p> : null}
            {catalog.status === 'error'
              ? <p className={css.pickerNote}>{labels.failed} <Button variant="ghost" size="sm" onClick={props.onRetry}>{labels.retry}</Button></p>
              : null}
            <div className={css.pickerList} role="listbox" aria-label={labels.label}>
              {words.length === 0
                ? <button type="button" role="option" aria-selected={unset} className={css.pickerOption} onClick={() => { pick('', '') }}>{labels.none}</button>
                : null}
              {groups.map(g => (
                <div key={g.id} role="group" aria-label={g.name}>
                  <div className={css.pickerGroup}>{g.name}</div>
                  {g.models.map(m => (
                    <button key={m.id} type="button" role="option" aria-selected={g.id === provider && m.id === model}
                      className={css.pickerOption} onClick={() => { pick(g.id, m.id) }}>
                      {m.name}<span className={css.pickerId}>{m.id}</span>
                    </button>
                  ))}
                </div>
              ))}
              {groups.length === 0 && words.length > 0 ? <p className={css.pickerNote}>{labels.noMatch}</p> : null}
            </div>
          </div>
        )
        : null}
    </div>
  )
}
