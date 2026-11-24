import { getContextRounds, getReplyText } from '../chat/reply.js'
import type { FileAttachment, Message, UserMessage } from '../chat/types.js'
import type { ReasoningEffort, SearchStrength } from '../composerOptions.js'
import { isOpenAIImage } from '../attachments.js'
import { imageDataUrl } from '../../utils/openAIImage.js'
import { serverFetch } from '../serverState.js'
import { ApiError } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageStreamEvent, StopReason, WebSearchToolResultBlock } from './types.js'

type ImagePart = { type: 'image_url'; image_url: { url: string } }
type TextPart = { type: 'text'; text: string }
type ChatMessage = { role: 'user' | 'assistant'; content: string | (ImagePart | TextPart)[] }

type ChatChunk = {
  id?: string
  model?: string
  choices?: {
    index: number
    delta?: {
      content?: string | null
      refusal?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
    }
    finish_reason?: string | null
  }[]
}

type ChatRequest = {
  model: string
  messages: ChatMessage[]
  effort: ReasoningEffort
  search?: boolean
  searchStrength?: SearchStrength
}

export const toOpenAIMessages = async (
  history: Message[],
  question: UserMessage,
  loadImage: (file: FileAttachment) => Promise<Blob | undefined>,
  signal?: AbortSignal,
  encode = imageDataUrl
): Promise<ChatMessage[]> => {
  const messages: ChatMessage[] = []
  let imageBytes = 0
  const cached = new Map<string, string>()
  const userContent = async (
    user: UserMessage,
    current: boolean
  ): Promise<ChatMessage['content']> => {
    const parts: (ImagePart | TextPart)[] = []
    if (user.content.trim()) {
      parts.push({ type: 'text', text: user.content })
    }
    for (const file of user.files) {
      if (!file.isImage || !isOpenAIImage(file.mimeType)) {
        continue
      }
      signal?.throwIfAborted()
      let url = cached.get(file.id)
      if (!url) {
        const blob = await loadImage(file)
        if (!blob) {
          if (current) {
            throw new ApiError('protocol', { key: 'imageUnavailable' })
          }
          continue
        }
        url = await encode(blob, file.name, file.mimeType, signal)
        cached.set(file.id, url)
      }
      imageBytes += url.length
      if (imageBytes > 24 * 1024 * 1024) {
        throw new ApiError('protocol', { key: 'imageRequestTooLarge' })
      }
      parts.push({ type: 'image_url', image_url: { url } })
    }
    return parts.some((part) => part.type === 'image_url') ? parts : user.content
  }
  for (const [user, reply] of getContextRounds(history)) {
    const content = await userContent(user, false)
    if (typeof content !== 'string' || content.trim()) {
      messages.push({ role: 'user', content }, { role: 'assistant', content: getReplyText(reply) })
    }
  }
  const content = await userContent(question, true)
  if (typeof content === 'string' && !content.trim()) {
    throw new ApiError('protocol', { key: 'imageUnavailable' })
  }
  messages.push({ role: 'user', content })
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
  { model, messages, effort, search, searchStrength }: ChatRequest,
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
        ...(searchStrength !== undefined
          ? { search_strength: searchStrength }
          : search
            ? { web_search: true }
            : {}),
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
  let nextIndex = 0
  let active: { type: 'text' | 'thinking'; index: number } | undefined
  const searches = new Set<string>()
  const fetches = new Set<string>()
  const closeBlock = (): MessageStreamEvent[] => {
    if (!active) {
      return []
    }
    const index = active.index
    active = undefined
    return [{ type: 'content_block_stop', index }]
  }
  const append = (type: 'text' | 'thinking', text: string): MessageStreamEvent[] => {
    if (!text) {
      return []
    }
    if (active?.type === type) {
      return [
        {
          type: 'content_block_delta',
          index: active.index,
          delta:
            type === 'text'
              ? { type: 'text_delta', text }
              : { type: 'thinking_delta', thinking: text },
        },
      ]
    }
    const events = closeBlock()
    active = { type, index: nextIndex++ }
    events.push({
      type: 'content_block_start',
      index: active.index,
      content_block:
        type === 'text'
          ? { type: 'text', text }
          : { type: 'thinking', thinking: text, signature: '' },
    })
    return events
  }
  for await (const { event, data } of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
    if (data.trim() === '[DONE]') {
      yield* closeBlock()
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
    if (event === 'chat-demo-fetch') {
      const item = payload as {
        phase?: unknown
        id?: unknown
        url?: unknown
        title?: unknown
        failed?: unknown
      }
      if (typeof item.id !== 'string') {
        continue
      }
      const url = typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : ''
      if (item.phase === 'start' && !fetches.has(item.id)) {
        if (!started) {
          started = true
          yield { type: 'message_start', message: { id: '', model } }
        }
        yield* closeBlock()
        fetches.add(item.id)
        const index = nextIndex++
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'server_tool_use',
            id: item.id,
            name: 'deepseek_web_search',
            input: { action: 'open_page', url },
            caller: { type: 'direct' },
            kind: 'deep_search',
          },
        }
        yield { type: 'content_block_stop', index }
      } else if (item.phase === 'result' && fetches.delete(item.id)) {
        const index = nextIndex++
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'web_fetch_tool_result',
            tool_use_id: item.id,
            kind: 'deep_search',
            content:
              item.failed === true || !url
                ? { type: 'web_fetch_tool_result_error', error_code: 'unavailable' }
                : {
                    type: 'web_fetch_result',
                    url,
                    content: {
                      type: 'document',
                      source: { type: 'text', media_type: 'text/plain', data: '' },
                      title: typeof item.title === 'string' ? item.title : null,
                    },
                    published_at: null,
                  },
          },
        }
        yield { type: 'content_block_stop', index }
      }
      continue
    }
    if (event === 'chat-demo-search') {
      const item = payload as {
        phase?: unknown
        id?: unknown
        query?: unknown
        results?: unknown
        failed?: unknown
      }
      if (typeof item.id !== 'string') {
        continue
      }
      if (item.phase === 'start' && !searches.has(item.id)) {
        if (!started) {
          started = true
          yield { type: 'message_start', message: { id: '', model } }
        }
        yield* closeBlock()
        searches.add(item.id)
        const index = nextIndex++
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'server_tool_use',
            id: item.id,
            name: 'deepseek_web_search',
            input: {
              action: 'search',
              queries: typeof item.query === 'string' && item.query ? [item.query] : [],
            },
            caller: { type: 'direct' },
            kind: 'deep_search',
          },
        }
        yield { type: 'content_block_stop', index }
      } else if (item.phase === 'result' && searches.delete(item.id)) {
        const content: WebSearchToolResultBlock['content'] = []
        if (item.failed === true) {
          content.push({ type: 'web_search_tool_result_error', error_code: 'unavailable' })
        } else if (Array.isArray(item.results)) {
          for (const source of item.results.slice(0, 10)) {
            if (!source || typeof source.url !== 'string' || !/^https?:\/\//i.test(source.url)) {
              continue
            }
            content.push({
              type: 'web_search_result',
              url: source.url,
              title: typeof source.title === 'string' ? source.title : '',
              snippet: typeof source.snippet === 'string' ? source.snippet : '',
              site_icon: null,
              site_name: null,
              encrypted_content: '',
              page_age: null,
            })
          }
        }
        const index = nextIndex++
        yield {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: item.id,
            kind: 'deep_search',
            content,
          },
        }
        yield { type: 'content_block_stop', index }
      }
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
    const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
    if (typeof reasoning === 'string') {
      yield* append('thinking', reasoning)
    }
    const text = choice?.delta?.content || choice?.delta?.refusal
    if (typeof text === 'string') {
      yield* append('text', text)
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
