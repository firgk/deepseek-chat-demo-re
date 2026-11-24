import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'

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

const { exportArchive } = await import('../src/services/chat/history/exportArchive.ts')
const { readSessionFile } = await import('../src/services/chat/history/schema.ts')
const { toLocalSession } = await import('../src/services/chat/history/toLocal.ts')
const { readArchive, readEntry, skipEntry } =
  await import('../src/services/chat/history/zipReader.ts')

const metadata = { provider: 'openai', model: 'gpt-5-2025-08-07', reasoningEffort: 'high' }

async function roundTrip(reply) {
  const timestamp = Date.UTC(2026, 5, 6)
  const zip = await exportArchive([
    {
      id: 'session-1',
      title: 'Chat',
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { id: '1', role: 'user', createdAt: timestamp, content: 'Hi', files: [] },
        {
          id: '2',
          role: 'assistant',
          createdAt: timestamp,
          status: 'done',
          prefix: false,
          blocks: [{ type: 'text', text: 'Reply' }],
          ...reply,
        },
      ],
    },
  ])
  const file = new File([zip], 'history.zip')
  for await (const entry of readArchive(file)) {
    if (entry.path === 'chat_sessions/session-1.json') {
      const json = JSON.parse(await (await readEntry(entry)).text())
      return toLocalSession(readSessionFile(json)).session.messages.at(-1)
    }
    await skipEntry(entry)
  }
  assert.fail('Missing session archive entry')
}

test('ZIP history preserves OpenAI provider, model, and reasoning effort', async () => {
  const reply = await roundTrip(metadata)
  assert.equal(reply.provider, 'openai')
  assert.equal(reply.model, 'gpt-5-2025-08-07')
  assert.equal(reply.reasoningEffort, 'high')
})

test('ZIP history with no provider metadata imports as an official DeepSeek reply', async () => {
  const reply = await roundTrip({ model: 'deepseek-flash' })
  assert.equal(reply.provider, undefined)
  assert.equal(reply.model, null)
  assert.equal(reply.reasoningEffort, undefined)
  assert.equal(reply.blocks[0].text, 'Reply')
})

test('a content-filtered reply keeps its refusal and provider metadata in ZIP history', async () => {
  const reply = await roundTrip({
    ...metadata,
    stopReason: 'refusal',
    blocks: [{ type: 'text', text: 'Filtered content' }],
  })
  assert.equal(reply.stopReason, 'refusal')
  assert.equal(reply.provider, 'openai')
  assert.equal(reply.blocks.length, 1)
  assert.ok(reply.blocks.every((block) => block.isTemplate && block.text !== 'Filtered content'))
})
