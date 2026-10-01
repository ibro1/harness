/**
 * The error every site connector throws, and the transport helpers both
 * connectors share: a per-call timeout, credential redaction, and the mapping of
 * thrown `fetch` failures and HTTP statuses to retryable or final refusals.
 */

/**
 * Why a publisher call failed. `auth`, `validation`, `not_found`, `conflict`,
 * `config`, `refused` and `bad_response` are final; `timeout`, `network`,
 * `rate_limited` and `server` may succeed when retried.
 */
export type PublisherErrorCode =
  | 'auth' | 'validation' | 'not_found' | 'conflict' | 'config' | 'refused' | 'bad_response'
  | 'timeout' | 'network' | 'rate_limited' | 'server'

/** A failed publisher call. Messages never contain an API key, user name or password. */
export class PublisherError extends Error {
  /**
   * @param message - the readable failure, already free of credentials.
   * @param status - the HTTP status, or 0 when no response arrived.
   * @param code - why the call failed, when known.
   * @param retryable - whether the same call may succeed later unchanged.
   */
  constructor(message: string, readonly status: number, readonly code: PublisherErrorCode | undefined, readonly retryable: boolean) {
    super(message)
    this.name = 'PublisherError'
  }
}

/**
 * A final error for a 2xx answer the connector cannot use.
 * @param message - what was missing or malformed.
 * @param status - the HTTP status of the answer.
 * @returns the error.
 */
export function badResponse(message: string, status: number): PublisherError {
  return new PublisherError(message, status, 'bad_response', false)
}

/**
 * A final error for an input the connector refuses before or without the site.
 * @param message - what is wrong with the input.
 * @param status - the HTTP status involved, or 0.
 * @returns the error.
 */
export function invalidInput(message: string, status: number): PublisherError {
  return new PublisherError(message, status, 'validation', false)
}

/** Secrets shorter than this are not redacted, so a one-letter user name cannot mangle every message. */
const MIN_REDACTED_LENGTH = 4

/**
 * Replace every occurrence of each secret in a message.
 * @param message - text that may echo a credential, such as a server's error body.
 * @param secrets - the credential values in use for the call.
 * @returns the message with each secret replaced by `[redacted]`.
 */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message
  for (const secret of secrets) {
    if (secret.length >= MIN_REDACTED_LENGTH) out = out.split(secret).join('[redacted]')
  }
  return out
}

/**
 * Classify an HTTP status that is not an authentication or validation refusal.
 * @param status - the response status.
 * @returns the code and whether retrying may help.
 */
export function statusFailure(status: number): { code: PublisherErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: 'auth', retryable: false }
  if (status === 404 || status === 410) return { code: 'not_found', retryable: false }
  if (status === 409) return { code: 'conflict', retryable: false }
  if (status === 400 || status === 422) return { code: 'validation', retryable: false }
  if (status === 429) return { code: 'rate_limited', retryable: true }
  if (status === 408 || status === 425 || status >= 500) return { code: 'server', retryable: true }
  return { code: 'refused', retryable: false }
}

/**
 * Combine the caller's signal with a per-call timeout.
 * @param signal - the caller's cancellation.
 * @param timeoutMs - abandon the call after this long.
 * @returns the combined signal and the timeout signal, to tell a timeout from a cancellation.
 */
export function callSignal(signal: AbortSignal, timeoutMs: number): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(timeoutMs)
  return { signal: AbortSignal.any([signal, timeout]), timeout }
}

/**
 * Map an error thrown by `fetch` or a body read. A cancellation by the caller is
 * rethrown unchanged; a timeout and a network failure become retryable errors.
 * @param error - the thrown value.
 * @param caller - the caller's signal.
 * @param timeout - the per-call timeout signal from {@link callSignal}.
 * @param what - the call, for example `Klipara GET /articles`; must not contain credentials.
 * @param secrets - credential values to strip from the underlying error text.
 * @returns never; always throws.
 */
export function transportFailure(
  error: unknown, caller: AbortSignal, timeout: AbortSignal, what: string, secrets: readonly string[],
): never {
  if (caller.aborted) throw caller.reason
  if (error instanceof PublisherError) throw error
  if (timeout.aborted) throw new PublisherError(`${what} timed out; try again later.`, 0, 'timeout', true)
  const detail = error instanceof Error ? error.message : String(error)
  throw new PublisherError(redact(`${what} failed before a response arrived: ${detail}`, secrets), 0, 'network', true)
}

/**
 * Best-effort record read.
 * @param value - a parsed JSON value.
 * @returns the object, or an empty one when it is not a plain object.
 */
export function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Best-effort string field; numbers become their decimal text so numeric ids read as strings.
 * @param value - a parsed JSON value.
 * @returns the text, or empty.
 */
export function text(value: unknown): string {
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

/**
 * Parse a body as JSON.
 * @param raw - the body text.
 * @returns the value, or undefined when it is not JSON.
 */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    // SyntaxError: the body is not JSON; callers treat undefined as "no structured body".
    return undefined
  }
}
