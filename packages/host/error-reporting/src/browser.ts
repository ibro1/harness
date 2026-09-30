/**
 * The Web UI's error reporter, bundled into one script and served by the
 * error-reporting plugin only while a DSN is configured. It reads its
 * settings from `globalThis.__DSH_SENTRY__` (injected into the page at request
 * time, so no DSN is baked into the build), reports window errors and
 * unhandled rejections, and exposes `globalThis.__DSH_REPORT_ERROR__` for the
 * UI's error boundaries. Every report passes the shared scrubber and goes to
 * the same-origin tunnel, never straight to the Sentry host.
 */

import {
  captureException, dedupeIntegration, globalHandlersIntegration, init, linkedErrorsIntegration, withScope,
} from '@sentry/browser'
import { expectedError, scrubEvent } from './scrub.ts'

/** The settings the plugin injects. */
interface BrowserSettings {
  dsn: string
  tunnel: string
  environment: string
  release?: string
  userId: string
}

const scope = globalThis as typeof globalThis & {
  __DSH_SENTRY__?: BrowserSettings
  __DSH_REPORT_ERROR__?: (error: unknown, tags?: Record<string, string>) => void
}
const settings = scope.__DSH_SENTRY__

if (settings !== undefined && settings.dsn !== '') {
  init({
    dsn: settings.dsn,
    tunnel: settings.tunnel,
    environment: settings.environment,
    ...settings.release === undefined || settings.release === '' ? {} : { release: settings.release },
    // No sessions, replay, feedback or tracing: only the integrations named here run.
    defaultIntegrations: false,
    integrations: [globalHandlersIntegration(), linkedErrorsIntegration(), dedupeIntegration()],
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    ignoreErrors: [/^Failed to fetch$/u, /^Load failed$/u, /NetworkError when attempting to fetch resource/u, /ResizeObserver loop/u],
    initialScope: { user: { id: settings.userId }, tags: { runtime: 'browser', route: location.pathname } },
    beforeSend: (event, hint) => expectedError(hint.originalException) ? null : scrubEvent(event) as typeof event,
  })
  scope.__DSH_REPORT_ERROR__ = (error, tags = {}) => {
    if (expectedError(error)) return
    withScope((local) => {
      local.setTags(tags)
      captureException(error)
    })
  }
}
