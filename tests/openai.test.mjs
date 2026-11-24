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
    await toOpenAIMessages(
      [
        user(''),
        reply('missing question'),
        user('Earlier question'),
        reply('Earlier answer'),
        user('Failed question'),
        reply('Incomplete answer', 'error'),
      ],
      user('New question'),
      async () => undefined
    ),
    [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'New question' },
    ]
  )
})

test('hidden selectors preserve the selected model and effort for new and existing chats', async (t) => {
  const { useServerState, chooseModel, chooseEffort, chooseManualModel } =
    await import('../src/services/serverState.ts')
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
      defaultReasoningEffort: 'default',
    },
    model: 'chosen-model',
    effort: 'high',
    showSelectors: false,
  })
  setDraftText(null, 'First prompt')
  assert.ok(sendMessage(null))
  const { activeId } = useChatStore.getState()
  chooseManualModel(' manual-model ')
  chooseEffort('max')
  assert.equal(useServerState.getState().model, 'manual-model')
  assert.deepEqual(useServerState.getState().manualModels, ['manual-model'])
  await waitForReplySave('First prompt')
  assert.equal(requests[0].model, 'chosen-model')
  assert.equal(requests[0].reasoning_effort, 'high')
  assert.equal(saved.messages.at(-1).reasoningEffort, 'high')

  chooseModel('chosen-model')
  chooseEffort('high')
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

test('saved model and effort initialize composer and model presets can be saved, applied and deleted', async (t) => {
  const {
    useServerState,
    loadServerSettings,
    chooseModel,
    chooseEffort,
    restoreModelDefaults,
    changeModelPreset,
    selectModelPreset,
  } = await import('../src/services/serverState.ts')
  let config = {
    baseUrl: 'https://example.com/v1',
    defaultModel: 'preferred',
    defaultReasoningEffort: 'high',
    hasApiKey: false,
    modelPresets: [],
  }
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/config') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body)
        if (body.addModelPreset)
          config = { ...config, modelPresets: [...config.modelPresets, body.addModelPreset] }
        if (body.removeModelPreset)
          config = {
            ...config,
            modelPresets: config.modelPresets.filter(
              (p) => JSON.stringify(p) !== JSON.stringify(body.removeModelPreset)
            ),
          }
      }
      return Response.json(config)
    }
    if (url === '/api/presets') return Response.json({ presets: [] })
    if (url === '/api/models') return Response.json({ models: ['preferred', 'other'] })
    assert.fail('Unexpected URL ' + url)
  })
  await loadServerSettings()
  assert.equal(useServerState.getState().model, 'preferred')
  assert.equal(useServerState.getState().effort, 'high')
  chooseModel('other')
  assert.equal(useServerState.getState().effort, 'default')
  chooseEffort('low')
  chooseModel('preferred')
  assert.equal(useServerState.getState().effort, 'high')
  chooseEffort('none')
  restoreModelDefaults()
  assert.equal(useServerState.getState().effort, 'high')
  chooseModel('other')
  chooseEffort('xhigh')
  const preset = { model: 'other', effort: 'xhigh', searchStrength: 'high' }
  await changeModelPreset(preset)
  assert.deepEqual(config.modelPresets, [preset])
  chooseModel('preferred')
  selectModelPreset(preset)
  assert.equal(config.baseUrl, 'https://example.com/v1')
  assert.equal(useServerState.getState().model, 'other')
  assert.equal(useServerState.getState().effort, 'xhigh')
  assert.equal(useServerState.getState().searchStrength, 'high')
  await loadServerSettings()
  assert.equal(useServerState.getState().model, 'other')
  await changeModelPreset(preset, true)
  assert.deepEqual(config.modelPresets, [])
  assert.equal(useServerState.getState().model, 'other')
})

test('OpenAI search and reasoning reuse the DeepSeek reply timeline', async (t) => {
  const { streamOpenAI } = await loadAdapter()
  const { applyEvent } = await import('../src/services/chat/reply.ts')
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const frame = (value) => 'data: ' + JSON.stringify(value) + '\n\n'
  const searchFrame = (value) => 'event: chat-demo-search\n' + frame(value)
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        frame(chunk({ reasoning_content: 'Thinking first' })) +
          searchFrame({ phase: 'start', id: 'web-search-0-0', query: 'node release' }) +
          searchFrame({
            phase: 'result',
            id: 'web-search-0-0',
            results: [{ url: 'https://nodejs.org/', title: 'Node', snippet: 'Docs' }],
          }) +
          frame(chunk({ reasoning: 'Thinking again' })) +
          frame(chunk({ content: 'Answer' })) +
          frame(chunk({}, 'stop')) +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  )
  const indexes = new Map()
  let reply = { id: 'reply', role: 'assistant', status: 'pending', blocks: [] }
  let sawSearch = false
  for await (const event of streamOpenAI(
    { ...request, search: true },
    new AbortController().signal
  )) {
    reply = applyEvent(reply, event, 100, indexes)
    if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') {
      const view = buildReplyView(reply, true)
      assert.equal(view.steps.at(-1).status, 'wip')
      assert.deepEqual(view.steps.at(-1).queries, ['node release'])
      sawSearch = true
    }
  }
  assert.ok(sawSearch)
  const view = buildReplyView(reply, false)
  assert.deepEqual(
    view.steps.map((step) => step.type),
    ['thinking', 'search', 'thinking']
  )
  assert.equal(view.steps[1].results.length, 1)
  assert.equal(view.searchResults[0].url, 'https://nodejs.org/')
  assert.equal(view.answer.text, 'Answer')
  assert.equal(reply.blocks[0].endedAt, 100)
})

test('image drafts remain local and OpenAI requests include images and image-only history', async () => {
  const { addDraftFiles, getDraft, prepareDraftMessage, clearDraft } =
    await import('../src/services/chat/drafts.ts')
  const { useUploads } = await import('../src/services/attachments.ts')
  const { toOpenAIMessages } = await loadAdapter()
  const image = new File(['image bytes'], 'test.png', { type: 'image/png' })
  const id = 'image-test'
  assert.equal(
    addDraftFiles(id, [new File(['text'], 'test.txt', { type: 'text/plain' })], '', true).key,
    'uploadImageOnly'
  )
  assert.equal(addDraftFiles(id, [image], '', true), null)
  const prepared = prepareDraftMessage(getDraft(id), {}, true)
  assert.equal(prepared.files.length, 1)
  const file = prepared.files[0]
  assert.equal(file.serverId, null)
  assert.equal(useUploads.getState().tasks[file.id], undefined)
  assert.equal(prepared.text, '')
  const user = { role: 'user', content: '', files: [file] }
  const reply = { role: 'assistant', status: 'done', blocks: [{ type: 'text', text: 'A picture' }] }
  const data = 'data:image/png;base64,aW1hZ2U='
  let encoded = 0
  const encode = async () => {
    encoded++
    return data
  }
  const messages = await toOpenAIMessages(
    [user, reply],
    { ...user, content: 'What is this?' },
    async () => image,
    undefined,
    encode
  )
  assert.deepEqual(messages, [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: data } }] },
    { role: 'assistant', content: 'A picture' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: data } },
      ],
    },
  ])
  assert.equal(encoded, 1)
  await assert.rejects(
    toOpenAIMessages([], user, async () => undefined, undefined, encode),
    { kind: 'protocol' }
  )
  clearDraft(id)
})

test('OpenAI fetch_url displays open-page progress, source and failure without storing body', async (t) => {
  const { streamOpenAI } = await loadAdapter()
  const { applyEvent } = await import('../src/services/chat/reply.ts')
  const { buildReplyView } = await import('../src/services/chat/view.ts')
  const frame = (value) => 'event: chat-demo-fetch\ndata: ' + JSON.stringify(value) + '\n\n'
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        frame({ phase: 'start', id: 'f1', url: 'https://example.org/' }) +
          frame({
            phase: 'result',
            id: 'f1',
            url: 'https://example.org/',
            title: 'Example',
            failed: false,
          }) +
          frame({ phase: 'start', id: 'f2', url: 'https://example.org/failure' }) +
          frame({ phase: 'result', id: 'f2', url: 'https://example.org/failure', failed: true }) +
          'data: ' +
          JSON.stringify(chunk({ content: 'Answer' })) +
          '\n\n' +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
  )
  let reply = { id: 'reply', role: 'assistant', provider: 'openai', status: 'pending', blocks: [] }
  const indexes = new Map()
  for await (const event of streamOpenAI(
    { ...request, search: true },
    new AbortController().signal
  )) {
    reply = applyEvent(reply, event, 100, indexes)
    if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') {
      assert.equal(buildReplyView(reply, true).steps.at(-1).pages.at(-1).status, 'wip')
    }
  }
  const view = buildReplyView(reply, false)
  assert.deepEqual(
    view.steps[0].pages.map((p) => p.status),
    ['done', 'failed']
  )
  assert.equal(view.sources[0].title, 'Example')
  assert.equal(view.searchResults[0].url, 'https://example.org/')
  assert.equal(view.answer.text, 'Answer')
})
