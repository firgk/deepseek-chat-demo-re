import clsx from 'clsx'
import { useEffect, useId, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14, IconSearchOutline16 } from '../base/icons.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import {
  effortLabels,
  effortOptions,
  matchesModel,
  searchLabels,
  searchStrengths,
} from '../../services/composerOptions.js'
import {
  changePreset,
  chooseEffort,
  chooseSearchStrength,
  chooseManualModel,
  chooseModel,
  changeModelPreset,
  modelPresetKey,
  type ModelPreset,
  selectModelPreset,
  serverEnabled,
  useServerState,
} from '../../services/serverState.js'
import { createId } from '../../utils/id.js'
import { useSettings } from '../../services/settings.js'
import styles from './ChatInput.module.css'

// The list scrolls independently. Its overflow is not part of the outer menu's
// scrollHeight, so include it when determining the menu's natural height.
const measureModelMenuHeight = (menu: HTMLElement) => {
  const list = menu.querySelector('[role="listbox"]')
  return menu.offsetHeight + (list ? Math.max(0, list.scrollHeight - list.clientHeight) : 0)
}

type PickerOption<T extends string> = {
  value: T
  label: string
  group?: string
  disabled?: boolean
}

const ComposerPicker = <T extends string>({
  label,
  value,
  options,
  onSelect,
  placeholder,
  compactLabel,
  disabled,
  className,
}: {
  label: string
  value: T | ''
  options: PickerOption<T>[]
  onSelect: (value: T) => void
  placeholder?: string
  compactLabel?: string
  disabled?: boolean
  className?: string
}) => {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listId = useId()
  const current = options.find((option) => option.value === value)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'end',
    maxHeight: 360,
    minSpace: 160,
    measureKey: options.length,
    measureHeight: measureModelMenuHeight,
  })
  const close = () => setOpen(false)
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })
  const select = (option: PickerOption<T>) => {
    if (option.disabled) {
      return
    }
    close()
    anchorRef.current?.focus({ preventScroll: true })
    onSelect(option.value)
  }
  const show = () => {
    const index = options.findIndex((option) => option.value === value && !option.disabled)
    setActive(
      index >= 0
        ? index
        : Math.max(
            0,
            options.findIndex((option) => !option.disabled)
          )
    )
    setOpen(true)
  }
  useEffect(() => {
    if (open) {
      floatingRef.current
        ?.querySelector<HTMLElement>('[role="listbox"]')
        ?.focus({ preventScroll: true })
    }
  }, [open, floatingRef])
  useEffect(() => {
    if (open) {
      floatingRef.current
        ?.querySelector('[data-active="true"]')
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, open, floatingRef])
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.modelPickerTrigger, className)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        title={current?.label ?? placeholder ?? label}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault()
            show()
          }
        }}
      >
        <span className={compactLabel ? styles.fullPickerLabel : undefined}>
          {current?.label ?? placeholder ?? label}
        </span>
        {compactLabel ? <span className={styles.compactPickerLabel}>{compactLabel}</span> : null}
        <IconChevronDownOutline14 />
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={floatingRef}
              className={clsx(styles.modelPickerMenu, styles.composerPickerMenu)}
              style={position ?? { visibility: 'hidden' }}
            >
              <div className={styles.pickerHeading}>{label}</div>
              <div
                id={listId}
                role="listbox"
                aria-label={label}
                tabIndex={0}
                aria-activedescendant={options[active] ? listId + '-' + active : undefined}
                className={styles.modelPickerList}
                onKeyDown={(event) => {
                  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault()
                    const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
                    let index =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? options.length - 1
                          : active + step
                    while (index >= 0 && index < options.length && options[index].disabled) {
                      index += step
                    }
                    if (index >= 0 && index < options.length) {
                      setActive(index)
                    }
                  } else if ((event.key === 'Enter' || event.key === ' ') && options[active]) {
                    event.preventDefault()
                    select(options[active])
                  } else if (event.key === 'Tab') {
                    close()
                    anchorRef.current?.focus({ preventScroll: true })
                  }
                }}
              >
                {options.map((option, index) => (
                  <div key={option.value} role="presentation">
                    {option.group && option.group !== options[index - 1]?.group ? (
                      <div className={styles.pickerGroup}>{option.group}</div>
                    ) : null}
                    <div
                      id={listId + '-' + index}
                      role="option"
                      aria-selected={option.value === value}
                      aria-disabled={option.disabled || undefined}
                      data-active={active === index}
                      className={styles.modelPickerOption}
                      onClick={() => select(option)}
                    >
                      <span>{option.label}</span>
                      {option.value === value ? <IconCheckOutline16 /> : null}
                    </div>
                  </div>
                ))}
                {!options.length ? (
                  <div className={styles.modelPickerEmpty}>{placeholder ?? label}</div>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

const ModelPicker = ({
  model,
  choices,
  disabled,
  zh,
  onManual,
}: {
  model: string
  choices: string[]
  disabled: boolean
  zh: boolean
  onManual: () => void
}) => {
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const matches = choices.filter((item) => matchesModel(item, query))
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, {
    side: 'top',
    align: 'end',
    maxHeight: 360,
    minSpace: 220,
    measureKey: query + ':' + matches.length,
    measureHeight: measureModelMenuHeight,
  })
  const close = () => setOpen(false)
  useDismiss(open, [anchorRef, floatingRef], close, { captureEscape: true })
  useEffect(() => {
    if (open && !mobile) {
      input.current?.focus({ preventScroll: true })
    }
  }, [open, mobile])
  useEffect(() => {
    if (open) {
      list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
    }
  }, [active, open])
  const select = (item: string) => {
    chooseModel(item)
    close()
    anchorRef.current?.focus()
  }
  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={clsx(styles.modelPickerTrigger, styles.modelControl)}
        aria-label={zh ? '模型' : 'Model'}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={model}
        onClick={() => {
          setQuery('')
          setActive(0)
          setOpen(!open)
        }}
      >
        <span>{model || (zh ? '选择模型' : 'Select model')}</span>
        <IconChevronDownOutline14 />
      </button>
      {open && !disabled
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.modelPickerMenu}
              style={position ?? { visibility: 'hidden' }}
            >
              <div className={styles.modelPickerSearch}>
                <IconSearchOutline16 />
                <input
                  ref={input}
                  role="combobox"
                  aria-label={zh ? '搜索模型' : 'Search models'}
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-activedescendant={matches[active] ? listId + '-' + active : undefined}
                  placeholder={zh ? '搜索模型…' : 'Search models…'}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value)
                    setActive(0)
                  }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) {
                      return
                    }
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      setActive((index) =>
                        Math.max(
                          0,
                          Math.min(matches.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))
                        )
                      )
                    } else if (event.key === 'Enter') {
                      event.preventDefault()
                      if (matches[active]) {
                        select(matches[active])
                      }
                    }
                  }}
                />
                <span className={styles.modelPickerCount}>
                  {matches.length}/{choices.length}
                </span>
              </div>
              <div
                ref={list}
                id={listId}
                role="listbox"
                aria-label={zh ? '模型列表' : 'Models'}
                className={styles.modelPickerList}
              >
                {matches.map((item, index) => (
                  <div
                    key={item}
                    id={listId + '-' + index}
                    role="option"
                    aria-selected={item === model}
                    data-active={index === active}
                    className={styles.modelPickerOption}
                    onClick={() => select(item)}
                  >
                    <span>{item}</span>
                    {item === model ? <IconCheckOutline16 /> : null}
                  </div>
                ))}
                {!matches.length ? (
                  <div className={styles.modelPickerEmpty}>
                    {zh ? '没有匹配的模型' : 'No matching models'}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                className={styles.modelPickerManual}
                onClick={() => {
                  close()
                  onManual()
                }}
              >
                {zh ? '手动输入模型 ID…' : 'Enter model ID…'}
              </button>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

export const ModelControls = () => {
  const zh = useSettings((state) => state.locale) === 'zh-CN'
  const { config, model, models, manualModels, effort, searchStrength, showSelectors } =
    useServerState()
  const [manual, setManual] = useState<string | null>(null)
  const [savingPreset, setSavingPreset] = useState(false)
  const [deletingPreset, setDeletingPreset] = useState<ModelPreset | null>(null)
  const [modelPresetError, setModelPresetError] = useState('')
  const modelPresets = config?.modelPresets ?? []
  const selectedPreset = modelPresets.find(
    (p) =>
      p.model === model && p.effort === effort && (p.searchStrength ?? 'off') === searchStrength
  )
  const updatePreset = async (preset: ModelPreset, remove = false) => {
    if (savingPreset) {
      return
    }
    setSavingPreset(true)
    setModelPresetError('')
    try {
      await changeModelPreset(preset, remove)
    } catch (error) {
      setModelPresetError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingPreset(false)
    }
  }
  if (!showSelectors && model) {
    return null
  }
  const choices = [
    ...new Set([model, ...models, ...manualModels, ...modelPresets.map((p) => p.model)]),
  ].filter(Boolean)
  return (
    <div className={styles.configSelectors}>
      <ModelPicker
        model={model}
        choices={choices}
        disabled={savingPreset}
        zh={zh}
        onManual={() => setManual('')}
      />
      <ComposerPicker
        label={zh ? '思考深度' : 'Reasoning effort'}
        className={styles.effortControl}
        compactLabel={effortLabels[effort][zh ? 0 : 1]}
        value={effort}
        disabled={savingPreset}
        options={effortOptions.map((item) => ({
          value: item,
          label: (zh ? '思考: ' : 'Think: ') + effortLabels[item][zh ? 0 : 1],
        }))}
        onSelect={chooseEffort}
      />
      <ComposerPicker
        label={zh ? '搜索强度' : 'Search strength'}
        className={styles.searchControl}
        value={searchStrength}
        disabled={savingPreset}
        options={searchStrengths.map((item) => ({
          value: item,
          label: (zh ? '搜索: ' : 'Search: ') + searchLabels[item][zh ? 0 : 1],
        }))}
        onSelect={chooseSearchStrength}
      />
      {config?.baseUrl ? (
        <>
          <ComposerPicker
            label={zh ? '模型预设' : 'Model presets'}
            className={styles.presetControl}
            placeholder={zh ? '选择预设' : 'Select preset'}
            compactLabel={zh ? '预设' : 'Presets'}
            value={selectedPreset ? modelPresetKey(selectedPreset) : ''}
            disabled={savingPreset}
            options={modelPresets.map((preset) => ({
              value: modelPresetKey(preset),
              label:
                preset.model +
                ' · ' +
                effortLabels[preset.effort][zh ? 0 : 1] +
                ' · ' +
                (zh ? '搜索: ' : 'Search: ') +
                searchLabels[preset.searchStrength ?? 'off'][zh ? 0 : 1],
            }))}
            onSelect={(value) => {
              const preset = modelPresets.find((item) => modelPresetKey(item) === value)
              if (preset) {
                selectModelPreset(preset)
              }
            }}
          />
          <Button
            size="s"
            variant="outlined"
            data-removing={Boolean(selectedPreset)}
            className={styles.defaultModelButton}
            aria-label={
              savingPreset
                ? zh
                  ? '处理中'
                  : 'Saving'
                : selectedPreset
                  ? zh
                    ? '删除预设'
                    : 'Delete preset'
                  : zh
                    ? '添加预设'
                    : 'Add preset'
            }
            disabled={!model || savingPreset}
            onClick={() => {
              if (selectedPreset) {
                setDeletingPreset(selectedPreset)
              } else {
                void updatePreset({ model, effort, searchStrength })
              }
            }}
          >
            <span className={styles.fullPresetAction}>
              {savingPreset
                ? zh
                  ? '处理中…'
                  : 'Saving…'
                : selectedPreset
                  ? zh
                    ? '删除预设'
                    : 'Delete preset'
                  : zh
                    ? '添加预设'
                    : 'Add preset'}
            </span>
            <span className={styles.compactPresetAction}>
              {savingPreset
                ? zh
                  ? '处理中'
                  : 'Saving'
                : selectedPreset
                  ? zh
                    ? '删除'
                    : 'Delete'
                  : zh
                    ? '添加'
                    : 'Add'}
            </span>
          </Button>
        </>
      ) : null}
      {modelPresetError ? (
        <small role="alert" className={styles.presetError}>
          {modelPresetError}
        </small>
      ) : null}
      {deletingPreset ? (
        <Modal
          title={zh ? '确认删除预设？' : 'Delete this preset?'}
          onClose={() => setDeletingPreset(null)}
          footer={
            <>
              <Button variant="outlined" onClick={() => setDeletingPreset(null)}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button
                variant="danger"
                disabled={savingPreset}
                onClick={() => {
                  const preset = deletingPreset
                  setDeletingPreset(null)
                  void updatePreset(preset, true)
                }}
              >
                {zh ? '确认删除' : 'Delete preset'}
              </Button>
            </>
          }
        >
          <div className={styles.deletePresetDetails}>
            <div>{deletingPreset.model}</div>
            <div>
              {zh ? '思考强度' : 'Reasoning effort'}:{' '}
              {effortLabels[deletingPreset.effort][zh ? 0 : 1]}
            </div>
            <div>
              {zh ? '搜索强度' : 'Search strength'}:{' '}
              {searchLabels[deletingPreset.searchStrength ?? 'off'][zh ? 0 : 1]}
            </div>
          </div>
        </Modal>
      ) : null}
      {manual !== null ? (
        <Modal
          closable
          title={zh ? '手动输入模型 ID' : 'Enter model ID'}
          onClose={() => setManual(null)}
        >
          <form
            className={styles.presetForm}
            onSubmit={(event) => {
              event.preventDefault()
              if (manual.trim()) {
                chooseManualModel(manual)
                setManual(null)
              }
            }}
          >
            <input
              aria-label={zh ? '模型 ID' : 'Model ID'}
              autoFocus
              required
              maxLength={1024}
              value={manual}
              onChange={(event) => setManual(event.currentTarget.value)}
            />
            <Button type="submit" size="s" disabled={!manual.trim()}>
              {zh ? '使用模型' : 'Use model'}
            </Button>
          </form>
        </Modal>
      ) : null}
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
      <ComposerPicker
        label={zh ? '快捷输入' : 'Quick prompts'}
        className={styles.quickControl}
        value=""
        placeholder={zh ? '快捷输入' : 'Quick prompts'}
        compactLabel={zh ? '快捷' : 'Prompts'}
        disabled={disabled || saving}
        options={[
          ...builtInPresets.map((item, index) => ({
            value: `built-in:${index}`,
            label: item[zh ? 0 : 1],
            group: zh ? '内置预设' : 'Built-in presets',
          })),
          ...presets.map((item) => ({
            value: `custom:${item.id}`,
            label: item.name,
            group: zh ? '自定义预设' : 'Custom presets',
          })),
          ...(serverEnabled()
            ? [
                {
                  value: 'save',
                  label: zh ? '保存草稿为预设' : 'Save draft as preset',
                  group: zh ? '管理' : 'Manage',
                  disabled: !draft.trim(),
                },
              ]
            : []),
        ]}
        onSelect={(value) => {
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
      />
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
