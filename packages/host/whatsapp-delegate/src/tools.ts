/**
 * The tools a contact's Session decides with. Each set is bound to one
 * contact: a Session can reply only to the person it was started for, and the
 * engine enforces the tiers, the rate limit and the secret check whatever the
 * arguments say.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { DelegateEngine } from './engine.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string', required: true, description: 'What happened.' } },
} as const satisfies ValueSchemaSpec

const CONTACT = { type: 'string', description: 'The contact\'s id or name. Optional: this session answers one contact, and another value is refused.' } as const

/** One tool, before it is bound to a contact. */
export interface DelegateToolSpec {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  run: (engine: DelegateEngine, contactId: string, args: Record<string, unknown>) => Promise<string>
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function messageId(value: unknown): number | undefined {
  const match = /^m?(\d+)$/u.exec(typeof value === 'number' ? String(value) : str(value).trim())
  return match === null ? undefined : Number(match[1])
}

/** The tools, unbound; the command route and the Sessions bind them. */
export const DELEGATE_TOOLS: readonly DelegateToolSpec[] = [
  {
    name: 'delegate_reply',
    description: 'Send one WhatsApp message to the contact as the owner. tier "routine" sends it now: acknowledgements, "looking into it", '
      + 'status updates, answers you are sure of, and confirming a fix you deployed and checked. tier "needs_approval" asks the owner first: '
      + 'anything about price or money, deadlines or dates, scope, promises, apologies for outages, anything legal or contractual, or anything '
      + 'you are unsure of. Call it once per message; long text is split into several messages.',
    parameters: {
      contact: CONTACT,
      text: { type: 'string', required: true, description: 'The message exactly as the contact will read it, in the owner\'s voice.' },
      tier: { type: 'string', required: true, enum: ['routine', 'needs_approval'], description: 'routine sends now; needs_approval waits for the owner.' },
      why: { type: 'string', required: true, description: 'One line on why this reply and this tier, for the owner.' },
      reply_to: { type: 'string', description: 'The id of the message this answers, such as m1234, to show it as a WhatsApp reply. Optional.' },
    },
    run: (engine, contactId, args) => {
      const quote = messageId(args['reply_to'])
      return engine.reply(contactId, {
        text: str(args['text']),
        tier: args['tier'] === 'needs_approval' ? 'needs_approval' : 'routine',
        why: str(args['why']),
        ...quote === undefined ? {} : { quote },
      })
    },
  },
  {
    name: 'delegate_no_reply',
    description: 'Decide that these messages get no reply (an emoji, "ok", thanks after a closed matter, something personal or not about work). '
      + 'Set tell_owner when the owner should hear about it: personal, sensitive, upset, or not something you should handle.',
    parameters: {
      contact: CONTACT,
      why: { type: 'string', required: true, description: 'Why no reply, in one line.' },
      tell_owner: { type: 'boolean', description: 'Mention it in the owner\'s digest.' },
    },
    run: (engine, contactId, args) => engine.noReply(contactId, str(args['why']), args['tell_owner'] === true),
  },
  {
    name: 'delegate_tell_owner',
    description: 'Tell the owner something about this contact: what you fixed and deployed (with the commit), an escalation, a question only he can '
      + 'answer. It goes in one digest at the end of the batch; urgent sends it now (the contact is upset, something is broken in production, '
      + 'you are stuck on something risky).',
    parameters: {
      contact: CONTACT,
      text: { type: 'string', required: true, description: 'The message for the owner. Never include secrets or setting values.' },
      urgent: { type: 'boolean', description: 'Send it now instead of in the digest.' },
    },
    run: (engine, contactId, args) => engine.tellOwner(contactId, str(args['text']), args['urgent'] === true),
  },
  {
    name: 'delegate_history',
    description: 'Read the contact\'s recent WhatsApp messages, both directions, oldest first, with their ids.',
    parameters: {
      contact: CONTACT,
      limit: { type: 'number', description: 'How many messages, up to 200 (default 30).' },
    },
    run: (engine, contactId, args) => {
      const limit = typeof args['limit'] === 'number' && args['limit'] > 0 ? Math.min(Math.floor(args['limit']), 200) : 30
      return engine.history(contactId, limit)
    },
  },
]

/**
 * Check the optional `contact` argument against the Session's own contact.
 * @param contactId - the Session's contact.
 * @param names - the contact's id and name.
 * @param given - the argument.
 * @returns an error message when it names someone else.
 */
export function wrongContact(contactId: string, names: readonly string[], given: unknown): string | undefined {
  if (typeof given !== 'string' || given.trim() === '') return undefined
  const value = given.trim().toLowerCase()
  return names.some(n => n.toLowerCase() === value) ? undefined : `This session answers only ${names[1] ?? contactId}; it cannot act for "${given}".`
}

/**
 * Bind the tools to one contact as harness tool definitions.
 * @param engine - the delegate.
 * @param contactId - the Session's contact.
 * @param names - the contact's id and name, for the `contact` check.
 * @returns the definitions.
 */
export function bindTools(engine: DelegateEngine, contactId: string, names: () => readonly string[]): ToolDefinition[] {
  return DELEGATE_TOOLS.map(spec => defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async (args) => {
      const record = args as Record<string, unknown>
      const wrong = wrongContact(contactId, names(), record['contact'])
      if (wrong !== undefined) throw new Error(wrong)
      return { text: await spec.run(engine, contactId, record) }
    },
    presentCall: () => ({ card: 'generic', title: spec.name.replace(/_/gu, ' '), kind: 'other', rawInput: '' }),
  }))
}
