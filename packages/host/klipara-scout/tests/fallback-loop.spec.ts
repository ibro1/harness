import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FallbackRouter, installFallback, type FallbackSwitch } from '../src/fallback.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

/** A provider that answers with its own name, or fails every request with a quota error while `down`. */
class NamedAdapter extends LlmAdapter {
  readonly models: string[] = []
  down = false
  quota = false
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    retryableCodes: ['SERVER'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'fallback test provider retryPolicy')

  constructor(private readonly label: string) { super() }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.models.push(options.model)
    if (this.quota) throw new LlmError('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h2m3s.', 'PI_AI_ERROR')
    if (this.down) throw new LlmError('temporary outage', 'SERVER')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.label }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.label } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function load(): Promise<Context> {
  context = new Context()
  await mountAgentLoopTestDependencies(context)
  await context.plugin(retry)
  await context.plugin(AgentLoop)
  return context
}

describe('scout fallback in the agent loop', () => {
  it('finishes a scout turn on the fallback after the harness retries give up, and returns to the shift model next turn', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const agy = new NamedAdapter('from agy')
    const opencode = new NamedAdapter('from opencode')
    loaded.llm.registerAdapter(['agy'], agy)
    loaded.llm.registerAdapter(['opencode'], opencode)
    const switches: FallbackSwitch[] = []
    const router = new FallbackRouter({ fallback: () => ({ provider: 'opencode', model: 'big-pickle' }), shift: () => undefined, cooldownMs: () => 0, onSwitch: (change) => { switches.push(change) } })
    installFallback(loaded, router, agent => String(agent.session.id).startsWith('scout-'))

    const agent = await loaded.agentLoop.create(SessionId('scout-1'), { provider: 'agy', model: 'gemini-3.8-flash-medium' })
    agy.down = true
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'shift' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // One first attempt and one harness retry on agy, then the fallback.
    expect(agy.models).toEqual(['gemini-3.8-flash-medium', 'gemini-3.8-flash-medium'])
    expect(opencode.models).toEqual(['big-pickle'])
    expect(switches).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'from opencode' }] })

    agy.down = false
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'reply check' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agy.models.at(-1)).toBe('gemini-3.8-flash-medium')
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'from agy' }] })
  })

  it('moves a spent quota to the fallback without the harness retries', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const agy = new NamedAdapter('from agy')
    const opencode = new NamedAdapter('from opencode')
    loaded.llm.registerAdapter(['agy'], agy)
    loaded.llm.registerAdapter(['opencode'], opencode)
    installFallback(loaded, new FallbackRouter({
      fallback: () => ({ provider: 'opencode', model: 'big-pickle' }), shift: () => undefined, cooldownMs: () => 0, onSwitch: () => undefined,
    }), agent => String(agent.session.id).startsWith('scout-'))
    const agent = await loaded.agentLoop.create(SessionId('scout-2'), { provider: 'agy', model: 'gemini-3.8-flash-medium' })
    agy.quota = true
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'shift' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agy.models).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'from opencode' }] })
    // Still benched: the next turn does not try agy.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'reply check' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(agy.models).toHaveLength(1)
    expect(opencode.models).toEqual(['big-pickle', 'big-pickle'])
  })

  it('leaves other Sessions on their failing model', { timeout: 60_000 }, async () => {
    const loaded = await load()
    const agy = new NamedAdapter('from agy')
    const opencode = new NamedAdapter('from opencode')
    loaded.llm.registerAdapter(['agy'], agy)
    loaded.llm.registerAdapter(['opencode'], opencode)
    installFallback(loaded, new FallbackRouter({ fallback: () => ({ provider: 'opencode', model: 'big-pickle' }), shift: () => undefined, cooldownMs: () => 0, onSwitch: () => undefined }), agent => String(agent.session.id).startsWith('scout-'))
    const agent = await loaded.agentLoop.create(SessionId('chat-1'), { provider: 'agy', model: 'gemini-3.8-flash-medium' })
    agy.down = true
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(opencode.models).toEqual([])
  })
})
