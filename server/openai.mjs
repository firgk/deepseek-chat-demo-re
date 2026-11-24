import { once } from 'node:events'
import { HttpError, isObject } from './http.mjs'

const ROLES = new Set(['system', 'developer', 'user', 'assistant'])
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const UPSTREAM_ERROR = 'The OpenAI provider could not complete the request.'
const DONE = 'data: [DONE]\n\n'

function chatPayload(config, body) {
  const model = body.model ?? config.defaultModel
  if (typeof model !== 'string' || !model.trim() || model.length > 1024) {
    throw new HttpError(400, 'Select an OpenAI model.')
  }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new HttpError(400, 'At least one chat message is required.')
  }
  const messages = body.messages.map((message) => {
    if (!ROLES.has(message?.role) || typeof message.content !== 'string') {
      throw new HttpError(400, 'OpenAI proxy messages must contain text.')
    }
    return { role: message.role, content: message.content }
  })
  const payload = { model, messages, stream: true }
  if (body.reasoning_effort !== undefined) {
    if (!REASONING_EFFORTS.has(body.reasoning_effort)) {
      throw new HttpError(400, 'Invalid OpenAI reasoning effort.')
    }
    payload.reasoning_effort = body.reasoning_effort
  }
  if (body.stream_options?.include_usage === true) {
    payload.stream_options = { include_usage: true }
  }
  return payload
}

async function upstream(config, endpoint, options, hasEffort = false) {
  const headers = {
    ...(config.apiKey && { Authorization: 'Bearer ' + config.apiKey }),
    ...options.headers,
  }
  let response
  try {
    response = await fetch(config.baseUrl + '/' + endpoint, {
      ...options,
      headers,
      redirect: 'error',
    })
  } catch {
    throw new HttpError(502, UPSTREAM_ERROR)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (hasEffort && [400, 422].includes(response.status)) {
      throw new HttpError(
        response.status,
        'The provider rejected the request. Select Default or another reasoning effort and retry.'
      )
    }
    if ([401, 403].includes(response.status)) {
      throw new HttpError(
        502,
        'The OpenAI provider denied access. Check its API key and model access.'
      )
    }
    throw new HttpError(response.status === 429 ? 429 : 502, UPSTREAM_ERROR)
  }
  return response
}

export async function listModels(config) {
  if (!config.baseUrl) {
    return { models: [] }
  }
  const response = await upstream(config, 'models', { signal: AbortSignal.timeout(15_000) })
  let data
  try {
    data = (await response.json()).data
  } catch {
    throw new HttpError(502, UPSTREAM_ERROR)
  }
  if (!Array.isArray(data)) {
    throw new HttpError(502, UPSTREAM_ERROR)
  }
  return {
    models: [
      ...new Set(
        data
          .map((model) => model?.id)
          .filter(
            (id) =>
              typeof id === 'string' && id.length && !(config.apiKey && id.includes(config.apiKey))
          )
      ),
    ],
  }
}

function safeFrame(lines, apiKey) {
  if (lines.some((line) => /^event: ?error\s*$/.test(line))) {
    throw new Error(UPSTREAM_ERROR)
  }
  const data = lines
    .filter((line) => line === 'data' || line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!data) {
    return ''
  }
  if (data.trim() === '[DONE]') {
    return DONE
  }
  let value
  try {
    value = JSON.parse(data)
  } catch {
    throw new Error(UPSTREAM_ERROR)
  }
  if (!isObject(value) || value.error !== undefined || value.type === 'error') {
    throw new Error(UPSTREAM_ERROR)
  }
  const sanitized = JSON.stringify(value, (field, part) => {
    if (!apiKey) {
      return part
    }
    if (field.includes(apiKey)) {
      throw new Error(UPSTREAM_ERROR)
    }
    return typeof part === 'string' ? part.replaceAll(apiKey, '[redacted]') : part
  })
  return 'data: ' + sanitized + '\n\n'
}

async function* readFrames(stream) {
  let remainder = ''
  let frame = []
  let size = 0
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    // Hold a trailing CR until the next chunk confirms whether the ending is CRLF.
    const lines = (remainder + chunk).split(/\r\n|\n|\r(?!$)/)
    remainder = lines.pop()
    for (const line of lines) {
      if (line === '') {
        yield frame
        frame = []
        size = 0
      } else {
        frame.push(line)
        size += line.length
      }
    }
    if (size + remainder.length > 8_000_000) {
      throw new Error(UPSTREAM_ERROR)
    }
  }
  if (remainder) {
    frame.push(remainder.replace(/\r$/, ''))
  }
  if (frame.length) {
    yield frame
  }
}

export async function streamChat(config, body, response) {
  if (!config.baseUrl) {
    throw new HttpError(400, 'Set the OpenAI base URL in Settings.')
  }
  const payload = chatPayload(config, body)
  if (response.destroyed) {
    return
  }
  const client = new AbortController()
  const signal = AbortSignal.any([client.signal, AbortSignal.timeout(10 * 60_000)])
  const cancel = () => client.abort()
  response.once('close', cancel)
  try {
    const result = await upstream(
      config,
      'chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal,
      },
      payload.reasoning_effort !== undefined
    )
    if (
      !result.body ||
      !/^text\/event-stream(?:\s*;|$)/i.test(result.headers.get('content-type') ?? '')
    ) {
      await result.body?.cancel()
      throw new HttpError(502, UPSTREAM_ERROR)
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    })
    response.flushHeaders()
    for await (const frame of readFrames(result.body)) {
      const data = safeFrame(frame, config.apiKey)
      if (data && !response.write(data)) {
        await once(response, 'drain', { signal })
      }
      if (data === DONE) {
        break
      }
    }
    response.end()
  } catch (error) {
    if (response.destroyed) {
      return
    }
    if (!response.headersSent) {
      throw error
    }
    response.end('data: ' + JSON.stringify({ error: { message: UPSTREAM_ERROR } }) + '\n\n')
  } finally {
    response.off('close', cancel)
  }
}
