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

const session = (id, title = id) => ({ id, title, createdAt: 1, updatedAt: 1, messages: [] })
const item = ({ messages: _messages, ...summary }, version = 1) => ({
  id: summary.id,
  version,
  deleted: false,
  summary,
})

let moduleNumber = 0
const loadModule = () => import(`../src/services/chat/remoteHistory.ts?test=${++moduleNumber}`)
const respond = (body, status = 200) => Response.json(body, { status })

const stubFetch = (t, responses) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body && JSON.parse(init.body),
      headers: new Headers(init?.headers),
    })
    assert.ok(responses.length, 'unexpected history request')
    const response = responses.shift()
    return typeof response === 'function' ? response() : response
  })
  return requests
}

test('startup migrates only never-seen IndexedDB sessions and returns the server summaries', async (t) => {
  const requests = stubFetch(t, [
    respond({
      revision: 8,
      items: [
        item(session('kept', 'Server title')),
        {
          id: 'removed',
          version: 2,
          deleted: true,
        },
      ],
    }),
    respond({ revision: 9, version: 1 }),
    respond({
      revision: 9,
      items: [
        item(session('kept', 'Server title')),
        {
          id: 'removed',
          version: 2,
          deleted: true,
        },
        item(session('new')),
      ],
    }),
  ])
  const history = await loadModule()
  const summaries = await history.loadRemoteSummaries(async () => [
    session('kept', 'Local title'),
    session('removed'),
    session('new'),
  ])

  assert.deepEqual(
    summaries.map(({ id, title }) => [id, title]),
    [
      ['kept', 'Server title'],
      ['new', 'new'],
    ]
  )
  assert.deepEqual(
    requests.map(({ method, url, body }) => [method, url, body]),
    [
      ['GET', '/api/sessions', undefined],
      ['PUT', '/api/sessions/new', { version: null, session: session('new') }],
      ['GET', '/api/sessions', undefined],
    ]
  )
  assert.equal(requests[1].headers.get('content-type'), 'application/json')
  assert.equal(requests[1].headers.get('x-chat-demo'), '1')
})

test('concurrent first migration adopts the server record and tombstone without blocking chat', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 0, items: [] }),
    respond({ error: 'conflict' }, 409),
    respond({ error: 'conflict' }, 409),
    respond({
      revision: 3,
      items: [item(session('same', 'Server title')), { id: 'deleted', version: 2, deleted: true }],
    }),
  ])
  const history = await loadModule()
  const summaries = await history.loadRemoteSummaries(async () => [
    session('same', 'Local title'),
    session('deleted'),
  ])
  assert.deepEqual(
    summaries.map(({ id, title }) => [id, title]),
    [['same', 'Server title']]
  )
  assert.equal(history.useHistoryConflict.getState(), false)
  assert.equal(requests.length, 4)
})

test('a newer detail cannot be used as a baseline for edits to an older listed session', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 2, items: [item(session('kept'), 2)] }),
    respond({ version: 3, session: session('kept', 'changed elsewhere') }),
  ])
  const history = await loadModule()
  await history.loadRemoteSummaries(async () => [])

  await assert.rejects(history.loadRemoteSession('kept'), /refresh/i)
  assert.equal(history.useHistoryConflict.getState(), true)
  await assert.rejects(history.saveRemoteSession(session('kept')), /refresh/i)
  assert.equal(requests.length, 2)
})

test('409 blocks queued and future stale writes while preserving attached originals', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 2, items: [item(session('kept'), 2)] }),
    respond({ version: 2, session: session('kept') }),
    respond({ error: 'conflict' }, 409),
  ])
  const history = await loadModule()
  await history.loadRemoteSummaries(async () => [])
  await history.loadRemoteSession('kept')

  let preserved = 0
  const results = await Promise.allSettled([
    history.saveRemoteSession(session('kept', 'First change')),
    history.saveRemoteSession(session('kept', 'Second change'), async () => {
      preserved++
    }),
  ])
  assert.deepEqual(
    results.map(({ status }) => status),
    ['rejected', 'rejected']
  )
  assert.equal(history.useHistoryConflict.getState(), true)
  assert.equal(requests.length, 3)
  assert.equal(requests[2].body.version, 2)
  assert.equal(preserved, 1)
})

test('a revision jump from an unrelated write cannot approve a stale collection replacement', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 2, items: [item(session('kept'), 2)] }),
    respond({ version: 2, session: session('kept') }),
    respond({ version: 3, revision: 4 }),
  ])
  const history = await loadModule()
  await history.loadRemoteSummaries(async () => [])
  await history.loadRemoteSession('kept')
  await history.saveRemoteSession(session('kept', 'Changed here'))

  let committed = false
  await assert.rejects(
    history.replaceRemoteSessions(
      async () => [],
      async () => {
        committed = true
      }
    ),
    /refresh/i
  )
  assert.equal(committed, false)
  assert.equal(history.useHistoryConflict.getState(), true)
  assert.equal(requests.length, 3)
})

test('serialized edits use the version returned for each accepted write', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 3, items: [] }),
    respond({ version: 1, revision: 4 }),
    respond({ version: 2, revision: 5 }),
    respond({ revision: 6, items: [{ id: 'new', version: 3, deleted: true }] }),
  ])
  const history = await loadModule()
  await history.loadRemoteSummaries(async () => [])
  await Promise.all([
    history.saveRemoteSession(session('new')),
    history.saveRemoteSession(session('new', 'New title')),
  ])
  let committed = false
  const summaries = await history.replaceRemoteSessions(
    async () => [],
    async () => {
      committed = true
    }
  )
  assert.deepEqual(
    requests.slice(1).map(({ body }) => body),
    [
      { version: null, session: session('new') },
      { version: 1, session: session('new', 'New title') },
      { revision: 5, sessions: [] },
    ]
  )
  assert.deepEqual(summaries, [])
  assert.equal(committed, true)
  await assert.rejects(history.saveRemoteSession(session('new')), /refresh/i)
  assert.equal(requests.length, 4)
})

test('renaming an unopened session and deleting it use successive versions', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 10, items: [item(session('old'), 4)] }),
    respond({ version: 4, session: session('old') }),
    respond({ version: 5, revision: 11 }),
    respond({ version: 6, revision: 12 }),
  ])
  const history = await loadModule()
  await history.loadRemoteSummaries(async () => [])
  await Promise.all([
    history.renameRemoteSession('old', 'Renamed'),
    history.deleteRemoteSession('old'),
  ])
  assert.deepEqual(
    requests.slice(1).map(({ method, body }) => [method, body]),
    [
      ['GET', undefined],
      ['PUT', { version: 4, session: session('old', 'Renamed') }],
      ['DELETE', { version: 5 }],
    ]
  )
  assert.equal(requests[3].headers.get('content-type'), 'application/json')
  assert.equal(requests[3].headers.get('x-chat-demo'), '1')
  assert.equal(await history.loadRemoteSession('old'), undefined)
})

test('a collection conflict preserves the committed local files and staged data', async (t) => {
  const requests = stubFetch(t, [
    respond({ revision: 10, items: [item(session('old'), 4)] }),
    respond({ error: 'conflict' }, 409),
  ])
  const history = await loadModule()
  await history.loadRemoteSummaries(async () => [])
  let committed = false
  await assert.rejects(
    history.replaceRemoteSessions(
      async () => [session('imported')],
      async () => {
        committed = true
      }
    ),
    /refresh/i
  )

  assert.equal(committed, false)
  assert.equal(history.useHistoryConflict.getState(), true)
  assert.deepEqual(requests[1].body, { revision: 10, sessions: [session('imported')] })
  await assert.rejects(
    history.replaceRemoteSessions(
      async () => [],
      async () => {}
    ),
    /refresh/i
  )
  assert.equal(requests.length, 2)
})

test('an expired authentication session returns the browser to sign-in', async (t) => {
  stubFetch(t, [respond({ error: 'Authentication required' }, 401)])
  const { useServerState } = await import('../src/services/serverState.ts')
  useServerState.setState({ auth: 'signed-in' })
  const history = await loadModule()
  await assert.rejects(
    history.loadRemoteSummaries(async () => []),
    /401/
  )
  assert.equal(useServerState.getState().auth, 'signed-out')
})
