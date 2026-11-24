import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return 'http://127.0.0.1:' + server.address().port
}

async function fixture(t, upstream = '') {
  const directory = await mkdtemp(join(tmpdir(), 'chat-demo-'))
  let server
  let url
  function close() {
    return new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections()
    })
  }
  t.after(async () => {
    if (server) {
      await close()
    }
    await rm(directory, { recursive: true, force: true })
  })
  const configPath = join(directory, '.config')
  await writeFile(
    configPath,
    'SITE_PASSWORD=first=password\nOPENAI_BASE_URL=' +
      upstream +
      '\nOPENAI_API_KEY=secret-token\nOPENAI_DEFAULT_MODEL=test-model\n'
  )
  const { createChatServer } = await import('./server.mjs')
  async function start() {
    server = await createChatServer({
      configPath,
      databasePath: join(directory, 'chat.sqlite'),
      distPath: directory,
    })
    url = await listen(server)
  }
  await start()
  async function request(path, { method = 'GET', body, cookie, header = true, headers } = {}) {
    return fetch(url + path, {
      method,
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(header && { 'X-Chat-Demo': '1' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
  async function login(password = 'first=password', headers) {
    return request('/api/login', { method: 'POST', body: { password }, headers })
  }
  async function signIn() {
    const response = await login()
    assert.equal(response.status, 200)
    const cookie = response.headers.get('set-cookie').split(';')[0]
    return (path, options) => request(path, { ...options, cookie })
  }
  async function restart() {
    await close()
    await start()
  }
  return { request, login, signIn, directory, configPath, restart }
}

test('protects API routes, rejects unmarked writes, and invalidates cookies on logout', async (t) => {
  const { request, login } = await fixture(t)
  assert.deepEqual(await (await request('/api/auth/session')).json(), { authenticated: false })
  assert.equal((await request('/api/config')).status, 401)
  assert.equal(
    (
      await request('/api/login', {
        method: 'POST',
        body: { password: 'first=password' },
        header: false,
      })
    ).status,
    403
  )
  assert.equal((await login('wrong')).status, 401)
  const response = await login(undefined, { 'X-Forwarded-Proto': 'https' })
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Secure/)
  const cookie = setCookie.split(';')[0]
  assert.deepEqual(await (await request('/api/auth/session', { cookie })).json(), {
    authenticated: true,
  })
  assert.equal(
    (
      await request('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cookie,
      })
    ).status,
    200
  )
  assert.equal((await request('/api/config', { cookie })).status, 401)
})

test('limits repeated failed logins', async (t) => {
  const { login } = await fixture(t)
  for (let index = 0; index < 5; index++) {
    assert.equal((await login('wrong')).status, 401)
  }
  assert.equal((await login()).status, 429)
})

test('serves only the frontend build files and marks the server index', async (t) => {
  const { request, directory } = await fixture(t)
  await writeFile(join(directory, 'index.html'), '<html><head></head><body></body></html>')
  await writeFile(join(directory, 'app.js'), '/* app */')
  assert.match(await (await request('/')).text(), /name="chat-demo-server" content="1"/)
  assert.equal(await (await request('/app.js')).text(), '/* app */')
  assert.equal((await request('/.config')).status, 404)
  assert.equal((await request('/chat.sqlite')).status, 404)
})

test('updates config atomically, redacts secrets, and rotates the login password', async (t) => {
  const { signIn, configPath, login } = await fixture(t, 'https://example.org/v1')
  const request = await signIn()
  assert.deepEqual(await (await request('/api/config')).json(), {
    baseUrl: 'https://example.org/v1',
    defaultModel: 'test-model',
    hasApiKey: true,
  })
  const update = {
    baseUrl: 'https://example.org/v1/',
    defaultModel: 'next',
    password: 'new=secret',
  }
  assert.equal((await request('/api/config', { method: 'PUT', body: update })).status, 200)
  assert.match(await readFile(configPath, 'utf8'), /SITE_PASSWORD=new=secret/)
  assert.match(await readFile(configPath, 'utf8'), /OPENAI_API_KEY=secret-token/)
  assert.equal((await request('/api/config')).status, 401)
  assert.equal((await login()).status, 401)
  assert.equal((await login('new=secret')).status, 200)
})

test('versions session updates, tombstones deleted IDs, and replaces a collection atomically', async (t) => {
  const request = await (await fixture(t)).signIn()
  const session = { id: 'one', title: 'One', createdAt: 10, updatedAt: 20, messages: [] }
  const other = { ...session, id: 'two' }
  const put = (id, version, value) =>
    request('/api/sessions/' + id, {
      method: 'PUT',
      body: { version, session: value },
    })
  assert.deepEqual(await (await request('/api/sessions')).json(), { revision: 0, items: [] })
  assert.deepEqual(await (await put('one', null, session)).json(), { version: 1, revision: 1 })
  assert.deepEqual(await (await put('two', null, other)).json(), { version: 1, revision: 2 })
  assert.equal((await put('one', null, session)).status, 409)
  assert.deepEqual(await (await request('/api/sessions/one')).json(), { version: 1, session })
  assert.equal(
    (
      await request('/api/sessions', {
        method: 'PUT',
        body: { revision: 1, sessions: [] },
      })
    ).status,
    409
  )
  const summary = { id: 'two', title: 'One', createdAt: 10, updatedAt: 20 }
  assert.deepEqual(
    await (
      await request('/api/sessions', {
        method: 'PUT',
        body: { revision: 2, sessions: [other] },
      })
    ).json(),
    {
      revision: 3,
      items: [
        { id: 'one', version: 2, deleted: true },
        { id: 'two', version: 1, deleted: false, summary },
      ],
    }
  )
  assert.equal((await put('one', null, session)).status, 409)
  assert.equal((await request('/api/sessions/one')).status, 404)
  assert.deepEqual(
    await (
      await request('/api/sessions/two', {
        method: 'DELETE',
        body: { version: 1 },
      })
    ).json(),
    { version: 2, revision: 4 }
  )
})

test('persists server-side system prompt presets', async (t) => {
  const request = await (await fixture(t)).signIn()
  const preset = { name: 'Example', text: 'Be concise.' }
  assert.deepEqual(
    await (
      await request('/api/presets/example', {
        method: 'PUT',
        body: preset,
      })
    ).json(),
    { presets: [{ id: 'example', ...preset }] }
  )
  assert.deepEqual(await (await request('/api/presets')).json(), {
    presets: [{ id: 'example', ...preset }],
  })
  assert.deepEqual(
    await (
      await request('/api/presets/example', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      })
    ).json(),
    { presets: [] }
  )
})

test('uses configured provider credentials and forwards only text chat fields', async (t) => {
  const received = []
  const upstream = createServer(async (request, response) => {
    const buffers = []
    for await (const chunk of request) {
      buffers.push(chunk)
    }
    received.push([request.url, request.headers.authorization, Buffer.concat(buffers).toString()])
    if (request.url === '/v1/models') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }))
    } else {
      response.setHeader('Content-Type', 'text/event-stream')
      response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
      response.end('data: [DONE]\n\n')
    }
  })
  t.after(() => new Promise((resolve) => upstream.close(resolve)))
  const request = await (await fixture(t, (await listen(upstream)) + '/v1')).signIn()
  assert.deepEqual(await (await request('/api/models')).json(), { models: ['alpha', 'beta'] })
  const messages = [{ role: 'user', content: 'Hello' }]
  const response = await request('/api/chat/completions', {
    method: 'POST',
    body: { messages, reasoning_effort: 'xhigh', tools: [], apiKey: 'attacker-key', stream: false },
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.match(await response.text(), /data: \[DONE\]/)
  assert.deepEqual(received, [
    ['/v1/models', 'Bearer secret-token', ''],
    [
      '/v1/chat/completions',
      'Bearer secret-token',
      JSON.stringify({
        model: 'test-model',
        messages,
        stream: true,
        reasoning_effort: 'xhigh',
      }),
    ],
  ])
})

test('rejects provider redirects and removes sensitive data from upstream errors', async (t) => {
  const upstream = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(307, { Location: '/redirect-target' })
      response.end()
    } else if (request.url === '/v1/chat/completions') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"secret-\\u0074oken"}}]}\n\n')
      response.end('event: error\ndata: {"error":{"message":"Bearer secret-token"}}\n\n')
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"data":[{"id":"redirect-target"}]}')
    }
  })
  t.after(() => new Promise((resolve) => upstream.close(resolve)))
  const request = await (await fixture(t, (await listen(upstream)) + '/v1')).signIn()
  assert.equal((await request('/api/models')).status, 502)
  const response = await request('/api/chat/completions', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'Hello' }] },
  })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.match(body, /"content":"\[redacted\]"/)
  assert.match(body, /The OpenAI provider could not complete the request/)
  assert.doesNotMatch(body, /secret-token/)
})

test('cancels an upstream stream when the client stops reading', async (t) => {
  let resolveClosed
  const closed = new Promise((resolve) => {
    resolveClosed = resolve
  })
  const upstream = createServer((request, response) => {
    response.on('close', resolveClosed)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
  })
  t.after(() => {
    upstream.close()
    upstream.closeAllConnections()
  })
  const request = await (await fixture(t, (await listen(upstream)) + '/v1')).signIn()
  const response = await request('/api/chat/completions', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'Hello' }] },
  })
  assert.equal(response.status, 200)
  const reader = response.body.getReader()
  assert.match(Buffer.from((await reader.read()).value).toString(), /"content":"hi"/)
  await reader.cancel()
  const abort = AbortSignal.timeout(1000)
  await Promise.race([
    closed,
    new Promise((_resolve, reject) => {
      abort.addEventListener('abort', () => reject(new Error('Upstream connection did not close.')))
    }),
  ])
})

test('requires entering or clearing the old key before it can be sent to a different provider', async (t) => {
  const { configPath, signIn } = await fixture(t, 'https://old.example/v1')
  await writeFile(configPath, (await readFile(configPath, 'utf8')) + '# Custom note\nOTHER=value\n')
  const request = await signIn()
  const provider = { baseUrl: 'https://new.example/v1', defaultModel: 'test-model' }
  const put = (body) => request('/api/config', { method: 'PUT', body })
  assert.equal((await put(provider)).status, 400)
  assert.equal((await (await request('/api/config')).json()).baseUrl, 'https://old.example/v1')
  assert.deepEqual(await (await put({ ...provider, apiKey: '' })).json(), {
    ...provider,
    hasApiKey: false,
  })
  assert.match(await readFile(configPath, 'utf8'), /# Custom note\nOTHER=value/)
})

test('suggests changing reasoning effort when a provider rejects a request that specifies it', async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(422, { 'Content-Type': 'application/json' })
    response.end('{"error":{"message":"internal credential: secret-token"}}')
  })
  t.after(() => new Promise((resolve) => upstream.close(resolve)))
  const request = await (await fixture(t, await listen(upstream))).signIn()
  const response = await request('/api/chat/completions', {
    method: 'POST',
    body: { messages: [{ role: 'user', content: 'Hello' }], reasoning_effort: 'high' },
  })
  assert.equal(response.status, 422)
  const { error } = await response.json()
  assert.match(error, /reasoning effort/)
  assert.match(error, /Default/)
  assert.doesNotMatch(error, /secret-token/)
})

test('reloads settings, versioned history, and prompt presets when the server restarts', async (t) => {
  const { signIn, restart } = await fixture(t)
  const request = await signIn()
  const session = { id: 'persisted', title: 'A chat', createdAt: 10, updatedAt: 10, messages: [] }
  assert.equal(
    (
      await request('/api/sessions/persisted', {
        method: 'PUT',
        body: { version: null, session },
      })
    ).status,
    200
  )
  const preset = { id: 'saved', name: 'Example', text: 'Use clear language.' }
  assert.equal((await request('/api/presets/saved', { method: 'PUT', body: preset })).status, 200)
  assert.equal(
    (
      await request('/api/config', {
        method: 'PUT',
        body: { baseUrl: '', defaultModel: 'changed' },
      })
    ).status,
    200
  )

  await restart()
  assert.equal((await request('/api/config')).status, 401)
  const afterRestart = await signIn()
  assert.deepEqual(await (await afterRestart('/api/config')).json(), {
    baseUrl: '',
    defaultModel: 'changed',
    hasApiKey: true,
  })
  assert.deepEqual(await (await afterRestart('/api/sessions/persisted')).json(), {
    version: 1,
    session,
  })
  assert.equal((await (await afterRestart('/api/sessions')).json()).revision, 1)
  assert.deepEqual(await (await afterRestart('/api/presets')).json(), { presets: [preset] })
})

test('accepts archived session IDs when migrating local history', async (t) => {
  const request = await (await fixture(t)).signIn()
  const id = 'archived-' + 'a'.repeat(257) + '\u0001'
  const session = { id, title: 'Archived chat', createdAt: 10, updatedAt: 10, messages: [] }
  const path = '/api/sessions/' + encodeURIComponent(id)
  assert.equal(
    (await request(path, { method: 'PUT', body: { version: null, session } })).status,
    200
  )
  assert.deepEqual(await (await request(path)).json(), { version: 1, session })
})
