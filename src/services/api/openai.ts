import { getContextRounds, getReplyText } from '../chat/reply.js'
import type { Message, UserMessage } from '../chat/types.js'
import type { ReasoningEffort } from '../composerOptions.js'
import { serverFetch } from '../serverState.js'
import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageStreamEvent, StopReason } from './types.js'

type ChatMessage = { role: 'user' | 'assistant'; content: string }

type ChatChunk = {
  id?: string
  model?: string
  choices?: {
    index: number
    delta?: { content?: string | null; refusal?: string | null }
    finish_reason?: string | null
  }[]
}

type ChatRequest = {
  model: string
  messages: ChatMessage[]
  effort: ReasoningEffort
}

export const toOpenAIMessages = (history: Message[], question: UserMessage): ChatMessage[] => {
  const messages: ChatMessage[] = []
  for (const [user, reply] of getContextRounds(history)) {
    if (user.content.trim()) {
      messages.push(
        { role: 'user', content: user.content },
        { role: 'assistant', content: getReplyText(reply) }
      )
    }
  }
  messages.push({ role: 'user', content: question.content })
  return messages
}

const readErrorMessage = (payload: unknown) => {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) {
    return undefined
  }
  const { error } = payload
  if (typeof error === 'string') {
    return error
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return typeof error.message === 'string' ? error.message : undefined
  }
  return undefined
}

const stopReason = (reason: string): StopReason => {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

export async function* streamOpenAI(
  { model, messages, effort }: ChatRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  signal.throwIfAborted()
  let response: Response
  try {
    response = await serverFetch('/api/chat/completions', {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(effort === 'default' ? {} : { reasoning_effort: effort }),
      }),
      signal,
    })
  } catch (error) {
    signal.throwIfAborted()
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }

  if (
    !response.ok ||
    !response.body ||
    !response.headers.get('Content-Type')?.includes('text/event-stream')
  ) {
    const payload: unknown = await response.json().catch(() => undefined)
    signal.throwIfAborted()
    throw new ApiError(
      response.ok ? 'protocol' : 'http',
      readErrorMessage(payload) ||
        (response.ok
          ? 'Expected a streaming response (text/event-stream).'
          : `HTTP ${response.status}`),
      response.status
    )
  }

  signal.throwIfAborted()
  let started = false
  let hasText = false
  for await (const { event, data } of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
    if (data.trim() === '[DONE]') {
      if (hasText) {
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_stop' }
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      // Some compatible servers emit keepalive data or plain-text error events.
    }
    const error = readErrorMessage(payload)
    if (error || event === 'error') {
      throw new ApiError('stream', error || data)
    }
    if (typeof payload !== 'object' || payload === null) {
      continue
    }
    const chunk = payload as ChatChunk
    if (!Array.isArray(chunk.choices)) {
      continue
    }
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: {
          id: typeof chunk.id === 'string' ? chunk.id : '',
          model: typeof chunk.model === 'string' && chunk.model ? chunk.model : model,
        },
      }
    }
    const choice = chunk.choices.find((item) => item?.index === 0)
    const text = choice?.delta?.content || choice?.delta?.refusal
    if (typeof text === 'string' && text) {
      if (!hasText) {
        hasText = true
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text } }
      } else {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
      }
    }
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
      yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason(choice.finish_reason), stop_sequence: null },
      }
    }
  }
  signal.throwIfAborted()
  throw new ApiError('interrupted', 'The OpenAI-compatible response ended before completion.')
}
