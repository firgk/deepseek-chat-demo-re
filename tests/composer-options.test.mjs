import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertPreset, effortOptions, matchesModel } from '../src/services/composerOptions.ts'

test('presets insert at the caret without replacing the draft or selection', () => {
  assert.deepEqual(insertPreset('前文原稿', 2, '请总结。'), {
    text: '前文请总结。原稿',
    caret: 6,
  })
  assert.deepEqual(insertPreset('', 0, '翻译'), { text: '翻译', caret: 2 })
})

test('the default and explicit disabled reasoning options are distinct', () => {
  assert.deepEqual(effortOptions, [
    'default',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ])
})

test('model search matches ordered characters without requiring adjacency', () => {
  assert.equal(matchesModel('deepseek', 'ds'), true)
  assert.equal(matchesModel('deepseek', 'sd'), false)
  assert.equal(matchesModel('DeepSeek-V3', 'DS3'), true)
  assert.equal(matchesModel('gpt-6-luna', 'g6l'), true)
  assert.equal(matchesModel('gpt-6-luna', 'lg'), false)
  assert.equal(matchesModel('deepseek', 'ddd'), false)
  assert.equal(matchesModel('deepseek', ''), true)
})
