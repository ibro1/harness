/**
 * The Dokploy, Cloudflare, Postgres, Klipara Scout, Error reporting, SEO employee and ads employee settings pages, browser
 * half: the servers, zones, accounts and databases an agent may act on, and the employees' shifts. It also draws an
 * on/off card for each deployment plugin that answers `/plugin-switch/<id>` (PSD tools, page capture, the CLI routes). Each page
 * registers into the Plugins page's `plugins.item` slot while the Host serves
 * its namespace, so a deployment that leaves a plugin out shows no trace of it.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { AdsCard } from './AdsCard.tsx'
import { AdsProposalsPage } from './AdsProposalsPage.tsx'
import { CloudflareCard } from './CloudflareCard.tsx'
import { DokployCard } from './DokployCard.tsx'
import { PostgresCard } from './PostgresCard.tsx'
import { ErrorReportingCard } from './ErrorReportingCard.tsx'
import { ScoutCard } from './ScoutCard.tsx'
import { ScoutLeadsPage } from './ScoutLeadsPage.tsx'
import { SeoCard } from './SeoCard.tsx'
import { SeoSitesPage } from './SeoSitesPage.tsx'
import { hostServesSwitch, SwitchCard } from './SwitchCard.tsx'
import { SWITCH_IDS } from './locales/switches.ts'
import { CLOUDFLARE_NS, CloudflareCardController } from './cloudflare-card-controller.ts'
import { DOKPLOY_NS, DokployCardController } from './dokploy-card-controller.ts'
import { POSTGRES_NS, PostgresCardController } from './postgres-card-controller.ts'
import { ERROR_REPORTING_NS, ErrorReportingCardController } from './error-reporting-card-controller.ts'
import { SCOUT_NS, ScoutCardController } from './scout-card-controller.ts'
import { ScoutModelCatalog } from './scout-model-catalog.ts'
import { SEO_NS, SeoCardController } from './seo-card-controller.ts'
import { AdsCardController } from './ads-card-controller.ts'
import { TikTokShopCard } from './TikTokShopCard.tsx'
import { TTS_NS, TtsCardController } from './tts-card-controller.ts'
import { YouTubeNicheScoutCard } from './YouTubeNicheScoutCard.tsx'
import { YNS_NS, YnsCardController } from './yns-card-controller.ts'
import { MeetingRemindersCard } from './MeetingRemindersCard.tsx'
import { MEETING_REMINDERS_NS, MeetingRemindersCardController } from './meeting-reminders-card-controller.ts'
import { WhatsAppDelegateCard } from './WhatsAppDelegateCard.tsx'
import { WAD_NS, WadCardController } from './whatsapp-delegate-card-controller.ts'
import { en, zh, type OperationsSettingsLocaleKey } from './locales.ts'

export type { CloudflareCardFace, CloudflareCardState, CloudflareSettings } from './cloudflare-card-controller.ts'
export type { DokployCardFace, DokployCardState, DokploySettings } from './dokploy-card-controller.ts'
export type { PostgresCardFace, PostgresCardState, PostgresSettings } from './postgres-card-controller.ts'
export type { ScoutCardFace, ScoutCardState, ScoutSettings } from './scout-card-controller.ts'
export type { SeoCardFace, SeoCardState, SeoSettings } from './seo-card-controller.ts'
export type { AdsCardFace, AdsCardState, AdsSettings } from './ads-card-controller.ts'
export type { TtsCardFace, TtsCardState, TtsSettings } from './tts-card-controller.ts'
export type { YnsCardFace, YnsCardState, YnsSettings, YnsStatus } from './yns-card-controller.ts'
export type { MeetingRemindersCardFace, MeetingRemindersCardState, MeetingRemindersSettings } from './meeting-reminders-card-controller.ts'
export type { WadCardFace, WadCardState, WadSettings } from './whatsapp-delegate-card-controller.ts'
export type { ErrorReportingCardFace, ErrorReportingCardState, ErrorReportingSettings } from './error-reporting-card-controller.ts'
export type { OperationsSettingsLocaleKey } from './locales.ts'
export type { SwitchCardFace, SwitchStatus } from './SwitchCard.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Dokploy, Cloudflare and Postgres settings page copy. */
    'settings.operations': OperationsSettingsLocaleKey
  }
}

/** The leads page's `plugins.item` id. */
const SCOUT_LEADS_ID = 'klipara-scout-leads'
/** The SEO sites page's `plugins.item` id. */
const SEO_SITES_ID = 'seo-employee-sites'
/** The Ads proposals page's `plugins.item` id. */
const ADS_PROPOSALS_ID = 'ads-employee-proposals'

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.operations'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/**
 * Mount each page while the Host serves its namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-operations: dictionaries')

  const dokploy = new DokployCardController(ctx.configForms.get(DOKPLOY_NS))
  const postgres = new PostgresCardController(ctx.configForms.get(POSTGRES_NS))
  const cloudflare = new CloudflareCardController(ctx.configForms.get(CLOUDFLARE_NS))
  const scout = new ScoutCardController(ctx.configForms.get(SCOUT_NS))
  // One model catalog serves every picker on the Klipara Scout and SEO employee cards.
  const scoutModels = new ScoutModelCatalog(ctx)
  const seo = new SeoCardController(ctx.configForms.get(SEO_NS))
  // The ads employee's settings live in the SEO employee's namespace; its card stages only the ads fields.
  const ads = new AdsCardController(ctx.configForms.get(SEO_NS))
  const errorReporting = new ErrorReportingCardController(ctx.configForms.get(ERROR_REPORTING_NS))
  const tts = new TtsCardController(ctx.configForms.get(TTS_NS))
  const yns = new YnsCardController(ctx.configForms.get(YNS_NS))
  const meetingReminders = new MeetingRemindersCardController(ctx.configForms.get(MEETING_REMINDERS_NS))
  const wad = new WadCardController(ctx.configForms.get(WAD_NS))
  // Adapters come and go, and a settings commit elsewhere can change the routes.
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { scoutModels.refresh() }), 'ui-settings-operations: scout model adapters')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { scoutModels.refresh() }), 'ui-settings-operations: scout model settings')
  ctx.effect(() => () => {
    dokploy.dispose()
    postgres.dispose()
    cloudflare.dispose()
    scout.dispose()
    errorReporting.dispose()
    seo.dispose()
    ads.dispose()
    tts.dispose()
    yns.dispose()
    meetingReminders.dispose()
    wad.dispose()
  }, 'ui-settings-operations: form subscriptions')

  ctx.effect(() => ctx.configForms.whileServed([DOKPLOY_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'dokploy', order: 50, label: () => t('dokployTitle'), locale: NS, inject: () => dokploy.inject(),
  }, DokployCard))), 'ui-settings-operations: Dokploy page')
  ctx.effect(() => ctx.configForms.whileServed([POSTGRES_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'postgres', order: 60, label: () => t('postgresTitle'), locale: NS, inject: () => postgres.inject(),
  }, PostgresCard))), 'ui-settings-operations: Postgres page')
  ctx.effect(() => ctx.configForms.whileServed([CLOUDFLARE_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'cloudflare', order: 70, label: () => t('cloudflareTitle'), locale: NS, inject: () => cloudflare.inject(),
  }, CloudflareCard))), 'ui-settings-operations: Cloudflare page')
  ctx.effect(() => ctx.configForms.whileServed([SCOUT_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'klipara-scout', order: 80, label: () => t('scoutTitle'), locale: NS,
    inject: () => {
      scoutModels.refresh()
      return scout.inject(() => { ctx.get('pluginNavigation')?.openItem(SCOUT_LEADS_ID) }, scoutModels.store, () => { scoutModels.refresh() })
    },
  }, ScoutCard))), 'ui-settings-operations: Klipara Scout page')
  ctx.effect(() => ctx.configForms.whileServed([ERROR_REPORTING_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'error-reporting', order: 90, label: () => t('errorsTitle'), locale: NS, inject: () => errorReporting.inject(),
  }, ErrorReportingCard))), 'ui-settings-operations: Error reporting page')
  ctx.effect(() => ctx.configForms.whileServed([SCOUT_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: SCOUT_LEADS_ID, order: 81, label: () => t('scoutLeadsPageTitle'), locale: NS,
  }, ScoutLeadsPage))), 'ui-settings-operations: Klipara Scout leads page')
  ctx.effect(() => ctx.configForms.whileServed([SEO_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'seo-employee', order: 82, label: () => t('seoTitle'), locale: NS,
    inject: () => {
      scoutModels.refresh()
      return seo.inject(() => { ctx.get('pluginNavigation')?.openItem(SEO_SITES_ID) }, scoutModels.store, () => { scoutModels.refresh() })
    },
  }, SeoCard))), 'ui-settings-operations: SEO employee page')
  ctx.effect(() => ctx.configForms.whileServed([SEO_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: SEO_SITES_ID, order: 83, label: () => t('seoSitesPageTitle'), locale: NS,
  }, SeoSitesPage))), 'ui-settings-operations: SEO sites page')
  ctx.effect(() => ctx.configForms.whileServed([SEO_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'ads-employee', order: 84, label: () => t('adsTitle'), locale: NS,
    inject: () => ads.inject(() => { ctx.get('pluginNavigation')?.openItem(ADS_PROPOSALS_ID) }),
  }, AdsCard))), 'ui-settings-operations: ads employee page')
  ctx.effect(() => ctx.configForms.whileServed([SEO_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: ADS_PROPOSALS_ID, order: 85, label: () => t('adsProposalsPageTitle'), locale: NS,
  }, AdsProposalsPage))), 'ui-settings-operations: Ads proposals page')
  ctx.effect(() => ctx.configForms.whileServed([TTS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'tiktok-shop-employee', order: 86, label: () => t('ttsTitle'), locale: NS,
    inject: () => {
      scoutModels.refresh()
      return tts.inject(scoutModels.store, () => { scoutModels.refresh() })
    },
  }, TikTokShopCard))), 'ui-settings-operations: TikTok Shop employee page')
  ctx.effect(() => ctx.configForms.whileServed([YNS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'youtube-niche-scout', order: 89, label: () => t('ynsTitle'), locale: NS,
    inject: () => {
      scoutModels.refresh()
      return yns.inject(scoutModels.store, () => { scoutModels.refresh() })
    },
  }, YouTubeNicheScoutCard))), 'ui-settings-operations: YouTube niche scout page')
  ctx.effect(() => ctx.configForms.whileServed([MEETING_REMINDERS_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'meeting-reminders', order: 87, label: () => t('mrTitle'), locale: NS, inject: () => meetingReminders.inject(),
  }, MeetingRemindersCard))), 'ui-settings-operations: Meeting reminders page')
  ctx.effect(() => ctx.configForms.whileServed([WAD_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'whatsapp-delegate', order: 88, label: () => t('wadTitle'), locale: NS,
    inject: () => {
      scoutModels.refresh()
      return wad.inject(scoutModels.store, () => { scoutModels.refresh() })
    },
  }, WhatsAppDelegateCard))), 'ui-settings-operations: WhatsApp delegate page')

  // The deployment plugins with only an on/off switch have no settings form to
  // gate their cards on; each card appears when the Host answers its status
  // route, probed once per page load (a plugin comes or goes only with a
  // redeploy, which reloads the page).
  SWITCH_IDS.forEach((switchId, index) => {
    ctx.effect(() => {
      let off: (() => void) | undefined
      let live = true
      void hostServesSwitch(switchId).then((served) => {
        if (!served || !live) return
        off = ctx.slots.inject('plugins.item', () => ctx.slots.register({
          name: 'plugins.item', id: `switch-${switchId}`, order: 100 + index, label: () => t(`switch.${switchId}.title`), locale: NS,
          inject: () => ({ switchId }),
        }, SwitchCard))
      })
      return () => {
        live = false
        off?.()
      }
    }, `ui-settings-operations: ${switchId} card`)
  })
}
