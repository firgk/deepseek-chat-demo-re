import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { streamChat } from './openai.mjs'
import { runSearch, runFetchUrl } from './search.mjs'

async function listen(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  )
  return 'http://127.0.0.1:' + server.address().port
}

const delta = (delta, finish_reason = null) => ({
  id: 'test',
  model: 'model',
  choices: [{ index: 0, delta, finish_reason }],
})
const sse = (response, frames) => {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const frame of frames) response.write('data: ' + JSON.stringify(frame) + '\n\n')
  response.end('data: [DONE]\n\n')
}
const toolFrames = [
  delta({
    tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"que' } }],
  }),
  delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"node release"}' } }] }),
  delta({}, 'tool_calls'),
]

async function fixture(t, reply, searchFn, strength = 'medium', fetchFn) {
  const requests = []
  const baseUrl = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    sse(response, reply(body, requests.length))
  })
  const endpoint = await listen(t, async (_request, response) => {
    await streamChat(
      { baseUrl, defaultModel: 'model', apiKey: 'test-secret' },
      { messages: [{ role: 'user', content: 'Latest Node version?' }], search_strength: strength },
      response,
      searchFn,
      fetchFn
    )
  })
  const result = await fetch(endpoint)
  return { requests, output: await result.text() }
}

test('web search assembles streamed arguments, runs function, and streams only the final completion', async (t) => {
  const queries = []
  const { requests, output } = await fixture(
    t,
    (_body, n) =>
      n === 1
        ? [delta({ reasoning_content: 'Need current information.' }), ...toolFrames]
        : [
            delta({ reasoning_content: 'Found documentation.' }),
            delta({ content: 'See [Node](https://nodejs.org/).' }),
            delta({}, 'stop'),
          ],
    async (args) => {
      queries.push(JSON.parse(args).query)
      return {
        results: [{ title: 'Node', url: 'https://nodejs.org/', snippet: 'Release information' }],
      }
    }
  )
  assert.deepEqual(queries, ['node release'])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].tools[0].function.name, 'web_search')
  assert.equal(requests[0].tool_choice, 'auto')
  assert.equal(requests[1].messages.at(-2).tool_calls[0].id, 'call_1')
  assert.equal(requests[1].messages.at(-1).role, 'tool')
  assert.equal(requests[1].messages.at(-1).tool_call_id, 'call_1')
  assert.match(requests[1].messages.at(-1).content, /nodejs.org/)
  assert.match(output, /See \[Node\]/)
  assert.doesNotMatch(output, /tool_calls|call_1/)
  const start = output.indexOf('"phase":"start"')
  const result = output.indexOf('"phase":"result"')
  assert.ok(output.indexOf('Need current information.') < start)
  assert.ok(start >= 0 && result > start)
  assert.ok(output.indexOf('Found documentation.') > result)
  assert.ok(output.indexOf('See [Node]') > result)
  assert.match(output, /event: chat-demo-search/)
  assert.match(output, /"query":"node release"/)
  assert.match(output, /"failed":false/)
  assert.equal(output.match(/\[DONE\]/g).length, 1)
})

test('search tools have a round limit and identical queries are deduplicated', async (t) => {
  let executions = 0
  const { requests, output } = await fixture(
    t,
    (_body, n) => (n <= 5 ? toolFrames : [delta({ content: 'Final' }), delta({}, 'stop')]),
    async () => {
      executions++
      return { error: 'No results' }
    }
  )
  assert.equal(requests.length, 6)
  assert.equal(executions, 1)
  assert.equal(requests[5].tools, undefined)
  assert.match(output, /Final/)
  assert.match(output, /"failed":true/)
  assert.equal(output.match(/\[DONE\]/g).length, 1)
})

test('search enabled without a tool call makes only one model request', async (t) => {
  const { requests, output } = await fixture(
    t,
    () => [delta({ content: 'Hello' }), delta({}, 'stop')],
    async () => assert.fail('Unexpected search')
  )
  assert.equal(requests.length, 1)
  assert.match(output, /Hello/)
})

test('search input is validated and results are restricted to bounded HTTP sources', async () => {
  const signal = new AbortController().signal
  assert.match((await runSearch('bad', signal)).error, /Invalid/)
  const result = await runSearch('{"query":"test"}', signal, async ({ limit }) => {
    assert.equal(limit, 5)
    return {
      sources: [
        { title: 'Invalid', url: 'javascript:alert(1)' },
        { title: 'Good', url: 'https://example.org/', snippet: 'x'.repeat(2000) },
      ],
    }
  })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].snippet.length, 1500)
  assert.match(
    (
      await runSearch('{"query":"test"}', signal, async () => {
        throw new Error('secret')
      })
    ).error,
    /unavailable/
  )
})

for (const [strength, limit, rounds] of [
  ['off', 0, 0],
  ['low', 5, 2],
  ['medium', 8, 5],
  ['high', 10, 10],
]) {
  test('search strength ' + strength + ' enforces result count and round budget', async (t) => {
    const limits = []
    const { requests, output } = await fixture(
      t,
      (_body, n) =>
        n <= rounds
          ? [
              delta({
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_' + n,
                    function: {
                      name: 'web_search',
                      arguments: JSON.stringify({ query: 'query ' + n }),
                    },
                  },
                ],
              }),
              delta({}, 'tool_calls'),
            ]
          : [delta({ content: 'Answer' }), delta({}, 'stop')],
      async (_args, _signal, _searchFn, count) => {
        limits.push(count)
        return { results: [] }
      },
      strength
    )
    assert.deepEqual(limits, Array(rounds).fill(limit))
    assert.equal(requests.length, rounds + 1)
    assert.equal(requests.at(-1).tools, undefined)
    assert.match(output, /Answer/)
    assert.equal(output.match(/\[DONE\]/g).length, 1)
  })
}

test('fetch_url reads bounded text and supports pagination, rejecting invalid URLs and images', async () => {
  const signal = new AbortController().signal
  const fetcher = async (input) => {
    assert.equal(input.url, 'https://example.org/article')
    assert.equal(input.maxLength, 8000)
    assert.equal(input.startIndex, 8000)
    return {
      kind: 'text',
      url: input.url,
      title: 'Article',
      content: 'x'.repeat(9000),
      totalChars: 20000,
    }
  }
  const result = await runFetchUrl(
    JSON.stringify({ url: 'https://example.org/article#part', startIndex: 8000 }),
    signal,
    fetcher
  )
  assert.equal(result.content.length, 8000)
  assert.equal(result.nextStartIndex, 16000)
  assert.equal(result.truncated, true)
  for (const url of [
    'file:///etc/passwd',
    'http://127.0.0.1',
    'http://[::1]',
    'http://localhost',
    'https://user:pass@example.org',
    'http://example.org:8080',
  ]) {
    assert.match(
      (await runFetchUrl(JSON.stringify({ url }), signal, () => assert.fail('Invalid URL fetched')))
        .error,
      /public/
    )
  }
  assert.match(
    (await runFetchUrl('{"url":"https://example.org","startIndex":-1}', signal)).error,
    /startIndex/
  )
  assert.match(
    (await runFetchUrl('{"url":"https://example.org"}', signal, async () => ({ kind: 'image' })))
      .error,
    /text only/
  )
  assert.match(
    (
      await runFetchUrl('{"url":"https://example.org"}', signal, async () => {
        throw new Error('secret')
      })
    ).error,
    /unavailable/
  )
})

test('search and fetch share round budget, return body to model but only metadata to browser', async (t) => {
  const calls = []
  const { requests, output } = await fixture(
    t,
    (_body, n) => {
      if (n === 1) return toolFrames
      if (n === 2 || n === 3)
        return [
          delta({
            tool_calls: [
              {
                index: 0,
                id: 'fetch_' + n,
                function: {
                  name: 'fetch_url',
                  arguments: JSON.stringify({
                    url: 'https://example.org/',
                    startIndex: (n - 2) * 8000,
                  }),
                },
              },
            ],
          }),
          delta({}, 'tool_calls'),
        ]
      return [delta({ content: 'Final answer' }), delta({}, 'stop')]
    },
    async () => ({
      results: [{ url: 'https://example.org/', title: 'Example', snippet: 'Summary' }],
    }),
    'medium',
    async (args) => {
      const { url, startIndex } = JSON.parse(args)
      calls.push(startIndex)
      return {
        url,
        title: 'Example article',
        content: 'PRIVATE_BODY_MARKER_' + startIndex,
        truncated: startIndex === 0,
        nextStartIndex: 8000,
      }
    }
  )
  assert.deepEqual(
    requests[0].tools.map((t) => t.function.name),
    ['web_search', 'fetch_url']
  )
  assert.deepEqual(calls, [0, 8000])
  assert.match(requests[2].messages.at(-1).content, /PRIVATE_BODY_MARKER_0/)
  assert.match(requests[3].messages.at(-1).content, /PRIVATE_BODY_MARKER_8000/)
  assert.match(output, /event: chat-demo-fetch/)
  assert.match(output, /Example article/)
  assert.doesNotMatch(output, /PRIVATE_BODY_MARKER/)
  assert.match(output, /Final answer/)
  assert.equal(output.match(/\[DONE\]/g).length, 1)
})
