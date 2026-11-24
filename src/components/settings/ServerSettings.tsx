import { useState, type FormEvent } from 'react'
import { createId } from '../../utils/id.js'
import { useSettings } from '../../services/settings.js'
import {
  changePreset,
  getModels,
  saveServerConfig,
  serverRequest,
  setProvider,
  setSelectorsVisible,
  useServerState,
} from '../../services/serverState.js'
import { Button } from '../base/Button.js'
import styles from './ServerSettings.module.css'

export const ServerSettings = () => {
  const zh = useSettings((state) => state.locale) === 'zh-CN'
  const { config, mode, showSelectors, models } = useServerState()
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '')
  const [defaultModel, setDefaultModel] = useState(config?.defaultModel ?? '')
  const [apiKey, setApiKey] = useState('')
  const [removeApiKey, setRemoveApiKey] = useState(false)
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>, success: string) => {
    setStatus('')
    setBusy(true)
    try {
      await action()
      setStatus(success)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    void run(
      async () => {
        await saveServerConfig({
          baseUrl: baseUrl.trim(),
          defaultModel: defaultModel.trim(),
          ...(removeApiKey || apiKey ? { apiKey: removeApiKey ? '' : apiKey } : {}),
          ...(password ? { password } : {}),
        })
        setApiKey('')
        setRemoveApiKey(false)
        setPassword('')
      },
      zh ? '配置已保存' : 'Configuration saved'
    )
  }

  return (
    <div className={styles.panel}>
      <fieldset className={styles.fields} disabled={busy}>
        <legend>{zh ? '模型 API' : 'Model API'}</legend>
        <label>
          {zh ? '当前服务' : 'Provider'}
          <select
            value={mode}
            onChange={(event) =>
              setProvider(event.currentTarget.value === 'openai' ? 'openai' : 'deepseek')
            }
          >
            <option value="deepseek">DeepSeek</option>
            <option value="openai" disabled={!config?.baseUrl}>
              OpenAI {zh ? '兼容' : 'compatible'}
            </option>
          </select>
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={showSelectors}
            onChange={(event) => setSelectorsVisible(event.currentTarget.checked)}
          />
          {zh ? '在输入框显示模型和思考深度' : 'Show model and reasoning controls in the composer'}
        </label>
        <form className={styles.fields} onSubmit={save}>
          <label>
            Base URL
            <input
              type="url"
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              disabled={removeApiKey}
              placeholder={
                config?.hasApiKey ? (zh ? '已设置，留空保留' : 'Set, leave blank to keep') : ''
              }
              onChange={(event) => setApiKey(event.currentTarget.value)}
            />
          </label>
          {config?.hasApiKey ? (
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={removeApiKey}
                onChange={(event) => setRemoveApiKey(event.currentTarget.checked)}
              />
              {zh ? '清除已保存的 API Key' : 'Clear the saved API key'}
            </label>
          ) : null}
          <label>
            {zh ? '默认模型 ID' : 'Default model ID'}
            <input
              list="saved-endpoint-models"
              value={defaultModel}
              onChange={(event) => setDefaultModel(event.currentTarget.value)}
            />
            <datalist id="saved-endpoint-models">
              {models.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          <label>
            {zh ? '新站点密码（留空保留）' : 'New site password (leave blank to keep)'}
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
          </label>
          <div className={styles.actions}>
            <Button type="submit" size="s">
              {zh ? '保存配置' : 'Save configuration'}
            </Button>
            <Button
              size="s"
              variant="outlined"
              disabled={!config?.baseUrl}
              onClick={() => void run(getModels, zh ? '已更新模型列表' : 'Model list updated')}
            >
              {zh ? '获取已保存端点的模型' : 'Fetch models from saved endpoint'}
            </Button>
          </div>
        </form>
      </fieldset>
      {status ? <small role="status">{status}</small> : null}
      <PresetSettings zh={zh} />
      <Button
        size="s"
        variant="outlined"
        disabled={busy}
        onClick={() => {
          void run(async () => {
            await serverRequest('/api/logout', { method: 'POST' })
            location.reload()
          }, '')
        }}
      >
        {zh ? '退出登录' : 'Sign out'}
      </Button>
    </div>
  )
}

const PresetSettings = ({ zh }: { zh: boolean }) => {
  const presets = useServerState((state) => state.presets)
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const select = (value: string) => {
    const preset = presets.find((item) => item.id === value)
    setId(value)
    setName(preset?.name ?? '')
    setText(preset?.text ?? '')
  }

  const save = async (remove: boolean) => {
    setStatus('')
    setBusy(true)
    try {
      const target = id || createId()
      await changePreset(target, remove ? undefined : { name: name.trim(), text: text.trim() })
      select('')
      setStatus(zh ? '已更新快捷输入' : 'Quick prompts updated')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className={styles.fields} disabled={busy}>
      <legend>{zh ? '自定义快捷输入' : 'Custom quick prompts'}</legend>
      <form
        className={styles.fields}
        onSubmit={(event) => {
          event.preventDefault()
          void save(false)
        }}
      >
        <label>
          {zh ? '选择预设' : 'Select preset'}
          <select value={id} onChange={(event) => select(event.currentTarget.value)}>
            <option value="">{zh ? '新增预设' : 'New preset'}</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? '预设名称' : 'Preset name'}
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        <label>
          {zh ? '预设内容' : 'Preset text'}
          <textarea
            required
            rows={2}
            maxLength={10000}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        <div className={styles.actions}>
          <Button type="submit" size="s" disabled={!name.trim() || !text.trim()}>
            {zh ? '保存预设' : 'Save preset'}
          </Button>
          {id ? (
            <Button size="s" variant="dangerOutlined" onClick={() => void save(true)}>
              {zh ? '删除预设' : 'Delete preset'}
            </Button>
          ) : null}
        </div>
        {status ? <small role="status">{status}</small> : null}
      </form>
    </fieldset>
  )
}
