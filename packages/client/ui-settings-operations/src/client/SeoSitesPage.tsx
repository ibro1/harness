/** The SEO sites page: its own entry on the Plugins page, opened from the SEO employee's settings. */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SeoSites } from './SeoSites.tsx'

/** Props the renderer binds for the sites page. */
export type SeoSitesPageProps = PropsRuntime<'plugins.item'> & PropsLocale<'settings.operations'>

/**
 * Render the sites page, or its one-line summary on the Plugins cards.
 * @param props - locale copy and the view being rendered.
 * @returns the page.
 */
export function SeoSitesPage(props: SeoSitesPageProps) {
  if (props.view === 'summary') return props.t('seoSitesDescription')
  return <SeoSites t={props.t} />
}
