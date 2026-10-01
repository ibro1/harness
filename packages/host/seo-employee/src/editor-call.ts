/**
 * The editorial review call. The plugin makes it itself, on the editor model
 * configured in settings, so a draft's verdict is recorded by code and not
 * claimed by the writing model. The prompt is built from the draft the tool
 * call carries, so the call is reconstructable from the session log.
 */

import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** The one LLM method the review needs. */
export interface LlmStreamer {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * Ask the editor model and return its text.
 * @param llm - the harness LLM service.
 * @param route - provider and model.
 * @param prompt - the complete editor prompt.
 * @param signal - cancels the call.
 * @returns the reply text.
 */
export async function askEditor(
  llm: LlmStreamer, route: { provider: string; model: string }, prompt: string, signal: AbortSignal,
): Promise<string> {
  let text = ''
  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 4000,
    signal,
  }
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(`The editor model (${route.provider}/${route.model}) failed: ${chunk.reason.failure.message}`)
    }
  }
  if (text.trim() === '') throw new Error(`The editor model (${route.provider}/${route.model}) returned no text.`)
  return text
}
