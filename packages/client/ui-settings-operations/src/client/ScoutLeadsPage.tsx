/** The Klipara Scout leads page: its own entry on the Plugins page, opened from the plugin's settings. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ScoutLeads } from './ScoutLeads.tsx'

/** Props the renderer binds for the leads page. */
export type ScoutLeadsPageProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.operations'>

/**
 * Render the leads page, or its one-line summary on the Plugins cards.
 * @param props - locale copy and the view being rendered.
 * @returns the page.
 */
export function ScoutLeadsPage(props: ScoutLeadsPageProps) {
  if (props.view === 'summary') return props.t('scoutLeadsDescription')
  return <ScoutLeads t={props.t} />
}
