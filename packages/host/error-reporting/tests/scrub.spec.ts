import { describe, expect, it } from 'vitest'
import { expectedError, scrubEvent, scrubString } from '../src/scrub.ts'

/** A lead as the scout stores it. */
const lead = {
  channelId: 'UCx9Qm2LagosMoneyTalk01',
  channelName: 'Lagos Money Talk',
  channelUrl: 'https://www.youtube.com/@lagosmoneytalk',
  subscribers: 18_400,
  email: 'hi@lagosmoneytalk.ng',
  videoTitle: 'Why Nigerian landlords demand 2 years rent upfront — with a property lawyer',
  videoUrl: 'https://www.youtube.com/watch?v=Ab3dEf9hIjK',
  stage: 'pitched',
  pitch: {
    via: 'email',
    to: 'hi@lagosmoneytalk.ng',
    text: 'Hi Tunde, I clipped the moment at 12:40 where your lawyer says advance rent is capped at 1 year. https://klipara.linkfa.de/s/Ab3dEf9hIjK — Klipara',
    at: '2026-09-30T09:31:00.000Z',
  },
  replies: [{ at: '2026-09-30T11:02:00.000Z', where: 'email', text: 'Love it! Call me on +234 803 123 4567 or 08031234567.' }],
}

/** Everything the report must never carry, in any form. */
const FORBIDDEN = [
  'lagosmoneytalk', 'Lagos Money Talk', 'Tunde', 'landlords demand', 'advance rent', 'Love it', '803 123 4567', '08031234567',
  'klp_sk_live_', 'secret-cookie', 'Ab3dEf9hIjK', 'sk-ant-api03', 'eyJhbGciOi', 'ya29.', 'oauth-code-123',
  'Write a pitch for', 'Here is the pitch', 'Sign in - Google Accounts',
]

function assertClean(value: unknown): void {
  const text = JSON.stringify(value)
  for (const forbidden of FORBIDDEN) expect(text, `leaked ${forbidden}`).not.toContain(forbidden)
}

describe('the error-report scrubber', () => {
  it('drops lead, pitch, reply and creator data at any depth, and keeps what locates the fault', () => {
    const event = scrubEvent({
      message: `Sample check for ${lead.channelName} failed`,
      exception: {
        values: [{
          type: 'Error',
          value: `Klipara refused POST /jobs for ${lead.videoTitle} (hi@lagosmoneytalk.ng): key klp_sk_live_a1b2c3d4e5f6g7h8i9j0 rejected`,
          stacktrace: { frames: [{ filename: '/app/packages/host/klipara-scout/src/index.ts', function: 'finishSample', lineno: 241, vars: { lead, apiKey: 'klp_sk_live_a1b2c3d4e5f6g7h8i9j0' } }] },
          mechanism: { type: 'generic', handled: true, data: { lead } },
        }],
      },
      tags: { plugin: 'klipara-scout', stage: 'sample', lead_id: lead.channelId, creator: lead.channelName, pitch: lead.pitch.text },
      extra: { lead, nested: { deeper: { state: { leads: [lead] } } }, note: 'Here is the pitch' },
      contexts: { lead: { ...lead }, runtime: { name: 'node', version: 'v22.20.0' } },
      user: { id: 'u-7f3a', email: 'netlinkogroup@gmail.com', username: 'admin', ip_address: '102.89.1.2' },
      breadcrumbs: [{ message: `pitched ${lead.email}` }],
    }, [lead.channelName, lead.videoTitle, lead.email])

    assertClean(event)
    expect(event.exception?.values?.[0]).toMatchObject({ type: 'Error', stacktrace: { frames: [{ function: 'finishSample', lineno: 241 }] } })
    expect(event.exception?.values?.[0]?.value).toContain('Klipara refused POST /jobs')
    expect(event.tags).toEqual({ plugin: 'klipara-scout', stage: 'sample', lead_id: lead.channelId })
    expect((event.contexts as Record<string, unknown>)['runtime']).toEqual({ name: 'node', version: 'v22.20.0' })
    expect(event.user).toEqual({ id: 'u-7f3a' })
    expect(event.breadcrumbs).toBeUndefined()
  })

  it('keeps no cookies, headers, bodies or query values of a request', () => {
    const event = scrubEvent({
      request: {
        method: 'POST',
        url: 'https://harness.linkfa.de/scout/command?token=secret-cookie&session=scout-1&code=oauth-code-123',
        headers: { Cookie: 'dsh_session=secret-cookie', Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
        cookies: { dsh_session: 'secret-cookie' },
        data: { name: 'scout_pitch', args: { text: lead.pitch.text } },
        query_string: 'token=secret-cookie',
        env: { REMOTE_ADDR: '102.89.1.2' },
      },
    })
    assertClean(event)
    expect(event.request).toEqual({ method: 'POST', url: 'https://harness.linkfa.de/scout/command' })
  })

  it('drops prompts, transcripts, model output and tool arguments of a failed session', () => {
    const event = scrubEvent({
      exception: { values: [{ type: 'LlmError', value: 'agy: RESOURCE_EXHAUSTED (code 429): Individual quota reached.' }] },
      tags: { provider: 'agy', model: 'gemini-3.8-flash-medium', session_id: 'scout-a52eb056-2630-4c81-a389-e12bfa76f870', plugin: 'klipara-scout' },
      extra: {
        prompt: 'Write a pitch for Lagos Money Talk',
        messages: [{ role: 'user', content: 'Write a pitch for Lagos Money Talk' }, { role: 'assistant', content: 'Here is the pitch' }],
        transcript: 'Tunde: advance rent is capped',
        toolCall: { name: 'outreach_browser_type', arguments: { text: lead.pitch.text } },
        page: { html: '<title>Sign in - Google Accounts</title>' },
      },
    })
    assertClean(event)
    expect(event.tags).toMatchObject({ provider: 'agy', model: 'gemini-3.8-flash-medium', session_id: 'scout-a52eb056-2630-4c81-a389-e12bfa76f870' })
  })

  it('redacts credentials and personal values inside any message', () => {
    const text = scrubString([
      'Authorization: Bearer ya29.a0AfH6SMBx-secret',
      'token sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'call +234 803 123 4567, mail hi@lagosmoneytalk.ng',
      'callback https://bug.linkfa.de/cb?code=oauth-code-123&state=xyz',
      'failed at 2026-09-30 10:00 for job 123456',
    ].join('\n'))
    assertClean(text)
    expect(text).toContain('failed at 2026-09-30 10:00 for job 123456')
  })
})

describe('expected failures', () => {
  it('skips 401/403/404, aborts, quota and browser network drops, and keeps real faults', () => {
    expect(expectedError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(true)
    expect(expectedError(Object.assign(new Error('nope'), { statusCode: 404 }))).toBe(true)
    expect(expectedError(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toBe(true)
    expect(expectedError(new Error('agy: RESOURCE_EXHAUSTED (code 429): Individual quota reached.'))).toBe(true)
    expect(expectedError(new TypeError('Failed to fetch'))).toBe(true)
    expect(expectedError(new TypeError('Load failed'))).toBe(true)
    expect(expectedError(new TypeError('Cannot read properties of undefined (reading \'stage\')'))).toBe(false)
    expect(expectedError(new Error('Klipara answered 500 with a non-JSON body'))).toBe(false)
  })
})
