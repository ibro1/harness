/**
 * Shared parts of the harness's AI employees (Klipara Scout, the SEO
 * employee): the daily shift Session, the fallback model for shift turns, and
 * owner alerts over WhatsApp. A library, not a plugin.
 */

export { FallbackRouter, installFallback, providerFailure, quotaFailure, resetAfterMs } from './fallback.ts'
export type { FallbackOptions, FallbackSwitch, Route, RouteFailure } from './fallback.ts'
export { whatsAppNotifier, whatsAppReader } from './notify.ts'
export type { WhatsAppMessage, WhatsAppRoute } from './notify.ts'
export { localTime, parseShiftTime, shiftDue, startShift } from './shift.ts'
export type { LocalTime, ShiftRequest } from './shift.ts'
