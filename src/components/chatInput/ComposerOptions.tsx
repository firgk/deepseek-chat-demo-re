import { useState } from 'react'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { effortOptions, type ReasoningEffort } from '../../services/composerOptions.js'
import {
  changePreset,
  chooseEffort,
  chooseModel,
  serverEnabled,
  useServerState,
} from '../../services/serverState.js'
import { createId } from '../../utils/id.js'
import { useSettings } from '../../services/settings.js'
import styles from './ChatInput.module.css'

export const effortLabels: Record<ReasoningEffort, [string, string]> = {
  default: ['默认', 'Default'],
  none: ['关闭', 'None'],
  minimal: ['极低', 'Minimal'],
  low: ['低', 'Low'],
  medium: ['中', 'Medium'],
  high: ['高', 'High'],
  xhigh: ['极高', 'Extra high'],
  max: ['最大', 'Max'],
}

export const ModelControls = () => {
  const zh = useSettings((state) => state.locale) === 'zh-CN'
  const { config, model, models, effort, showSelectors } = useServerState()
  if (!showSelectors) {
    return null
  }
  const choices = [...new Set([model, config?.defaultModel ?? '', ...models])].filter(Boolean)
  return (
    <div className={styles.configSelectors}>
      <select
        aria-label={zh ? '模型' : 'Model'}
        value={model}
        onChange={(event) => chooseModel(event.currentTarget.value)}
      >
        {!model ? <option value="">{zh ? '选择模型' : 'Select model'}</option> : null}
        {choices.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <select
        aria-label={zh ? '思考深度' : 'Reasoning effort'}
        value={effort}
        onChange={(event) => {
          const value = effortOptions.find((item) => item === event.currentTarget.value)
          if (value) {
            chooseEffort(value)
          }
        }}
      >
        {effortOptions.map((item) => (
          <option key={item} value={item}>
            {effortLabels[item][zh ? 0 : 1]}
          </option>
        ))}
      </select>
    </div>
  )
}

const builtInPresets = [
  ['总结一下', 'Summarize', '请总结以下内容：\n', 'Summarize the following:\n'],
  [
    '翻译成中文',
    'Translate into Chinese',
    '请将以下内容翻译成中文：\n',
    'Translate the following into Chinese:\n',
  ],
  ['润色文字', 'Polish writing', '请润色以下文字：\n', 'Polish the following text:\n'],
  ['解释代码', 'Explain code', '请解释以下代码：\n', 'Explain the following code:\n'],
]

type QuickPromptsProps = { draft: string; disabled: boolean; onInsert: (text: string) => void }

export const QuickPrompts = ({ draft, disabled, onInsert }: QuickPromptsProps) => {
  const zh = useSettings((state) => state.locale) === 'zh-CN'
  const presets = useServerState((state) => state.presets)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState<string | null>(null)

  const save = async () => {
    const normalized = name?.trim()
    if (!normalized || !draft.trim() || saving) {
      return
    }
    setSaving(true)
    setError('')
    try {
      await changePreset(createId(), { name: normalized, text: draft })
      setName(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={styles.configSelectors}>
      <select
        aria-label={zh ? '快捷输入' : 'Quick prompts'}
        value=""
        disabled={disabled || saving}
        onChange={(event) => {
          const value = event.currentTarget.value
          if (value === 'save') {
            setError('')
            setName('')
          } else if (value.startsWith('built-in:')) {
            const item = builtInPresets[Number(value.slice(9))]
            if (item) {
              onInsert(item[zh ? 2 : 3])
            }
          } else if (value.startsWith('custom:')) {
            const preset = presets.find((item) => item.id === value.slice(7))
            if (preset) {
              onInsert(preset.text)
            }
          }
        }}
      >
        <option value="">{zh ? '快捷输入' : 'Quick prompts'}</option>
        <optgroup label={zh ? '内置预设' : 'Built-in presets'}>
          {builtInPresets.map((item, index) => (
            <option key={item[1]} value={`built-in:${index}`}>
              {item[zh ? 0 : 1]}
            </option>
          ))}
        </optgroup>
        {presets.length > 0 ? (
          <optgroup label={zh ? '自定义预设' : 'Custom presets'}>
            {presets.map((item) => (
              <option key={item.id} value={`custom:${item.id}`}>
                {item.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {serverEnabled() ? (
          <option value="save" disabled={!draft.trim()}>
            {zh ? '保存草稿为预设' : 'Save draft as preset'}
          </option>
        ) : null}
      </select>
      {name !== null ? (
        <Modal
          closable
          title={zh ? '保存草稿为预设' : 'Save draft as preset'}
          onClose={() => {
            if (!saving) {
              setName(null)
            }
          }}
        >
          <form
            className={styles.presetForm}
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <label htmlFor="quick-prompt-name">{zh ? '预设名称' : 'Preset name'}</label>
            <input
              id="quick-prompt-name"
              autoFocus
              required
              maxLength={100}
              value={name}
              disabled={saving}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <Button type="submit" size="s" disabled={saving || !name.trim()}>
              {zh ? '保存预设' : 'Save preset'}
            </Button>
            {error ? (
              <small role="alert" className={styles.presetError}>
                {error}
              </small>
            ) : null}
          </form>
        </Modal>
      ) : null}
    </div>
  )
}
