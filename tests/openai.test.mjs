import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const sourceDirectory = new URL('../src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(sourceDirectory) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context)
    }
    return nextResolve(specifier, context)
  },
})

globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
globalThis.document = { querySelector: () => null }

const loadAdapter = () => import('../src/services/api/openai.ts')
const prompt = { role: 'user', content: 'Hello' }
const request = { model: 'gpt-5', messages: [prompt], effort: 'default' }

function eventStream(events) {
  const encoder = new TextEncoder()
  const text = events
    .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`)
    .join('')
  const bytes = encoder.encode(text)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) {
          controller.enqueue(bytes.slice(i, i + 3))
        }
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}

function chunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'gpt-5-2025-08-07',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

async function collect(events) {
  const result = []
  for await (const event of events) {
    result.push(event)
  }
  return result
}

test('sends default-effort requests and renders fragmented Chat Completions text', async (t) => {
  const { streamOpenAI } = await loadAdapter()
  const { applyEvent, getReplyText, settleReply } = await import('../src/services/chat/reply.ts')
  t.mock.method(globalThis, 'fetch', (url, init) => {
    assert.equal(url, '/api/chat/completions')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.get('Content-Type'), 'application/json')
    assert.equal(init.headers.get('X-Chat-Demo'), '1')
    assert.deepEqual(JSON.parse(init.body), {
      model: 'gpt-5',
      messages: [prompt],
      stream: true,
    })
    return eventStream([
      chunk({ role: 'assistant', content: '' }),
      chunk({ content: '你好' }),
      chunk({ content: ' 🌊' }),
      chunk({}, 'length'),
      '[DONE]',
    ])
  })
  const events = await collect(streamOpenAI(request, new AbortController().signal))
  const indexes = new Map()
  const reply = events.reduce((result, event) => applyEvent(result, event, 1, indexes), {
    role: 'assistant',
    status: 'pending',
    blocks: [],
  })
  assert.equal(getReplyText(settleReply(reply, 'done', 2)), '你好 🌊')
  assert.equal(reply.stopReason, 'max_tokens')
  assert.equal(events[0].message.model, 'gpt-5-2025-08-07')
  assert.equal(events.at(-1).type, 'message_stop')
})

test('preserves rejected reasoning effort details from the upstream response', async (t) => {
  const { streamOpenAI } = await loadAdapter()
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    assert.equal(JSON.parse(init.body).reasoning_effort, 'xhigh')
    return Response.json(
      { error: { message: "Unsupported value: 'xhigh' for reasoning_effort" } },
      { status: 400 }
    )
  })
  await assert.rejects(
    collect(streamOpenAI({ ...request, effort: 'xhigh' }, new AbortController().signal)),
    { kind: 'http', status: 400, message: /Unsupported value: 'xhigh'/ }
  )
})

test('recognizes OpenAI-compatible stream errors and incomplete streams', async (t) => {
  const { streamOpenAI } = await loadAdapter()
  t.mock.method(globalThis, 'fetch', async () =>
    eventStream([{ error: { message: 'Upstream overloaded' } }])
  )
  await assert.rejects(collect(streamOpenAI(request, new AbortController().signal)), {
    kind: 'stream',
    message: 'Upstream overloaded',
  })
  globalThis.fetch.mock.mockImplementation(async () => eventStream([chunk({ content: 'partial' })]))
  await assert.rejects(collect(streamOpenAI(request, new AbortController().signal)), {
    kind: 'interrupted',
  })
})

test('aborting cancels a pending read', async (t) => {
  const { streamOpenAI } = await loadAdapter()
  const controller = new AbortController()
  let canceled = false
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(chunk({ role: 'assistant' }))}\n\n`)
            )
          },
          cancel() {
            canceled = true
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  )
  const events = streamOpenAI(request, controller.signal)
  assert.equal((await events.next()).value.type, 'message_start')
  const next = events.next()
  controller.abort()
  await assert.rejects(next, { name: 'AbortError' })
  assert.ok(canceled)
})

test('builds plain-text context and skips past attachment-only and failed turns', async () => {
  const { toOpenAIMessages } = await loadAdapter()
  const user = (content) => ({ role: 'user', content, files: [{ serverId: 'file-1' }] })
  const reply = (text, status = 'done') => ({
    role: 'assistant',
    status,
    latestReminder: 'not valid in OpenAI',
    blocks: [
      { type: 'thinking', thinking: 'private' },
      { type: 'server_tool_use', name: 'deepseek_read_url' },
      { type: 'text', text },
    ],
  })
  assert.deepEqual(
    toOpenAIMessages(
      [
        user(''),
        reply('missing question'),
        user('Earlier question'),
        reply('Earlier answer'),
        user('Failed question'),
        reply('Incomplete answer', 'error'),
      ],
      user('New question')
    ),
    [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'New question' },
    ]
  )
})

test('hidden selectors send the configured model with default effort and preserve chosen settings', async (t) => {
  const { useServerState } = await import('../src/services/serverState.ts')
  const { loadRemoteSummaries } = await import('../src/services/chat/remoteHistory.ts')
  const { setDraftText } = await import('../src/services/chat/drafts.ts')
  const { sendMessage, useChatStore } = await import('../src/services/chat/store.ts')
  t.mock.method(document, 'querySelector', () => ({}))
  Object.assign(document, { visibilityState: 'hidden' })
  globalThis.cancelAnimationFrame = () => {}
  const logStorageError = console.error
  t.mock.method(console, 'error', (...args) => {
    const [message, error] = args
    // This Node test exercises server persistence. IndexedDB is available in the browser.
    if (
      message !== '[storage] mirror server session failed' ||
      error?.message !== 'indexedDB is not defined'
    ) {
      logStorageError(...args)
    }
  })

  let revision = 0
  const requests = []
  let saved
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/sessions') {
      return Response.json({ revision, items: [] })
    }
    if (url.startsWith('/api/sessions/')) {
      saved = JSON.parse(init.body).session
      revision += 1
      return Response.json({ revision, version: revision })
    }
    assert.equal(url, '/api/chat/completions')
    requests.push(JSON.parse(init.body))
    return eventStream([chunk({ content: 'Reply' }), chunk({}, 'stop'), '[DONE]'])
  })
  await loadRemoteSummaries(async () => [])
  useChatStore.setState({ ready: true })
  useServerState.setState({
    mode: 'openai',
    config: {
      baseUrl: 'https://example.com/v1',
      hasApiKey: false,
      defaultModel: 'configured-model',
    },
    model: 'chosen-model',
    effort: 'high',
    showSelectors: false,
  })
  setDraftText(null, 'First prompt')
  assert.ok(sendMessage(null))
  const { activeId } = useChatStore.getState()
  await waitForReplySave('First prompt')
  assert.equal(requests[0].model, 'configured-model')
  assert.equal(Object.hasOwn(requests[0], 'reasoning_effort'), false)
  assert.equal(saved.messages.at(-1).reasoningEffort, 'default')

  useServerState.setState({ showSelectors: true })
  setDraftText(activeId, 'Second prompt')
  assert.ok(sendMessage(activeId))
  await waitForReplySave('Second prompt')
  assert.equal(requests[1].model, 'chosen-model')
  assert.equal(requests[1].reasoning_effort, 'high')
  assert.deepEqual(requests[1].messages, [
    { role: 'user', content: 'First prompt' },
    { role: 'assistant', content: 'Reply' },
    { role: 'user', content: 'Second prompt' },
  ])
  const reply = saved.messages.at(-1)
  assert.equal(reply.model, 'gpt-5-2025-08-07')
  assert.equal(reply.reasoningEffort, 'high')

  async function waitForReplySave(prompt) {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
      if (saved?.messages.at(-2).content === prompt && saved.messages.at(-1).status === 'done') {
        return
      }
    }
    assert.fail('Reply did not finish and save')
  }
})
