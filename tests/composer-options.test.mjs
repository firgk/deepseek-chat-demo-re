import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertPreset, effortOptions } from '../src/services/composerOptions.ts'

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
