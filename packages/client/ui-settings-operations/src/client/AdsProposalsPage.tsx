/** The Ads proposals page: its own entry on the Plugins page, opened from the ads employee's settings. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AdsProposals } from './AdsProposals.tsx'

/** Props the renderer binds for the proposals page. */
export type AdsProposalsPageProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.operations'>

/**
 * Render the proposals page, or its one-line summary on the Plugins cards.
 * @param props - locale copy and the view being rendered.
 * @returns the page.
 */
export function AdsProposalsPage(props: AdsProposalsPageProps) {
  if (props.view === 'summary') return props.t('adsProposalsDescription')
  return <AdsProposals t={props.t} />
}
