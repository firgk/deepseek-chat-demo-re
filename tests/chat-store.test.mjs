import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { before, mock } from 'node:test'

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
globalThis.document = { querySelector: () => ({}) }

const { loadRemoteSummaries, useHistoryConflict } =
  await import('../src/services/chat/remoteHistory.ts')
const { getDraft, setDraftText } = await import('../src/services/chat/drafts.ts')
const { useServerState } = await import('../src/services/serverState.ts')
const {
  editMessage,
  regenerateReply,
  removeSession,
  renameSession,
  selectSession,
  sendMessage,
  useChatStore,
} = await import('../src/services/chat/store.ts')

const summary = { id: 'remote-1', title: 'Session', createdAt: 1, updatedAt: 1 }
const unopened = { ...summary, id: 'remote-2', title: 'Unopened' }
const session = {
  ...summary,
  rootMessageId: 'user-1',
  messages: [
    {
      id: 'user-1',
      role: 'user',
      content: 'Hello',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'reply-1',
    },
    {
      id: 'reply-1',
      role: 'assistant',
      parentId: 'user-1',
      createdAt: 1,
      provider: 'openai',
      model: 'test-model',
      reasoningEffort: 'default',
      prefix: false,
      status: 'streaming',
      blocks: [{ type: 'text', text: 'Partial' }],
    },
  ],
}

before(async () => {
  const list = mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, '/api/sessions')
    return Response.json({
      revision: 1,
      items: [summary, unopened].map((item) => ({
        id: item.id,
        deleted: false,
        version: 1,
        summary: item,
      })),
    })
  })
  try {
    const sessions = await loadRemoteSummaries(async () => [])
    useChatStore.setState({ ready: true, sessions })
  } finally {
    list.mock.restore()
  }
})

test('viewing an in-flight remote reply does not write a new revision', async (t) => {
  const logError = console.error
  t.mock.method(console, 'error', (...args) => {
    const [message, error] = args
    if (
      message !== '[storage] mirror server session failed' ||
      error?.message !== 'indexedDB is not defined'
    ) {
      logError(...args)
    }
  })
  let writes = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (init?.method === 'PUT') {
      writes += 1
      return Response.json({ revision: 2, version: 2 })
    }
    assert.equal(url, '/api/sessions/remote-1')
    return Response.json({ version: 1, session })
  })
  selectSession(summary.id)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(useChatStore.getState().sessionCache[summary.id].messages.at(-1).status, 'stopped')
  assert.equal(writes, 0)
})

test('a failed rename of an unopened server session leaves the saved title visible', async (t) => {
  t.mock.method(console, 'error', () => {})
  let writes = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/sessions/remote-2')
    if (init?.method === 'PUT') {
      writes += 1
      return Response.json({ error: 'Unavailable' }, { status: 503 })
    }
    return Response.json({ version: 1, session: { ...unopened, messages: [] } })
  })
  renameSession(unopened.id, 'Pending rename')
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(writes, 1)
  assert.equal(
    useChatStore.getState().sessions.find((item) => item.id === unopened.id).title,
    'Unopened'
  )
})

test('a history conflict blocks chat mutations and preserves the text draft', async (t) => {
  const requests = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  useServerState.setState({ mode: 'openai', model: 'test-model' })
  useHistoryConflict.setState(true, true)
  useChatStore.setState({ sessionCache: { [summary.id]: session } })

  setDraftText(summary.id, 'Unsent draft')
  assert.equal(sendMessage(summary.id), false)
  assert.equal(editMessage(summary.id, 'user-1', 'Edit'), false)
  regenerateReply(summary.id, 'reply-1')
  renameSession(summary.id, 'Rename')
  assert.equal(await removeSession(summary.id), false)

  assert.equal(getDraft(summary.id).text, 'Unsent draft')
  assert.equal(useChatStore.getState().sessionCache[summary.id], session)
  assert.equal(requests.mock.callCount(), 0)
})
