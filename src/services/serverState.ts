import { create } from 'zustand'
import { searchStrengths, type ReasoningEffort, type SearchStrength } from './composerOptions.js'

export const serverEnabled = () =>
  typeof document !== 'undefined' &&
  document.querySelector('meta[name="chat-demo-server"]') !== null

export type ModelPreset = {
  model: string
  effort: ReasoningEffort
  searchStrength?: SearchStrength
}
export const modelPresetKey = (preset: ModelPreset) =>
  JSON.stringify([preset.model, preset.effort, preset.searchStrength ?? 'off'])

export type ServerConfig = {
  baseUrl: string
  hasApiKey: boolean
  modelPresets?: ModelPreset[]
}
export type PromptPreset = { id: string; name: string; text: string }
type Mode = 'deepseek' | 'openai'
type ServerState = {
  auth: 'checking' | 'signed-out' | 'signed-in'
  mode: Mode
  config: ServerConfig | null
  model: string
  effort: ReasoningEffort
  searchStrength: SearchStrength
  efforts: ReadonlyMap<string, ReasoningEffort>
  showSelectors: boolean
  models: string[]
  manualModels: string[]
  presets: PromptPreset[]
}

const storedPreference = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const setPreference = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Preferences can still be used for the current page.
  }
}

const initialSearchStrength = (): SearchStrength =>
  searchStrengths.find((value) => value === storedPreference('chat-demo:search-strength')) ??
  (storedPreference('chat-demo:search') === 'true' ? 'medium' : 'off')

export const useServerState = create<ServerState>(() => ({
  auth: 'checking',
  mode:
    serverEnabled() && storedPreference('chat-demo:provider') === 'openai' ? 'openai' : 'deepseek',
  config: null,
  model: '',
  effort: 'default',
  searchStrength: initialSearchStrength(),
  efforts: new Map(),
  showSelectors: storedPreference('chat-demo:model-selectors') !== 'false',
  models: [],
  manualModels: [],
  presets: [],
}))

export const setProvider = (mode: Mode) => {
  setPreference('chat-demo:provider', mode)
  useServerState.setState({ mode })
}

export const setSelectorsVisible = (showSelectors: boolean) => {
  setPreference('chat-demo:model-selectors', String(showSelectors))
  useServerState.setState({ showSelectors })
}

export const chooseModel = (model: string) => {
  useServerState.setState((state) => ({
    model,
    effort: state.efforts.get(model) ?? 'default',
  }))
}

export const chooseSearchStrength = (searchStrength: SearchStrength) => {
  setPreference('chat-demo:search-strength', searchStrength)
  useServerState.setState({ searchStrength })
}

export const selectModelPreset = (preset: ModelPreset) => {
  chooseSearchStrength(preset.searchStrength ?? 'off')
  useServerState.setState((state) => ({
    model: preset.model,
    effort: preset.effort,
    efforts: new Map(state.efforts).set(preset.model, preset.effort),
  }))
  setPreference('chat-demo:model-preset', modelPresetKey(preset))
}

export const chooseManualModel = (value: string) => {
  const model = value.trim()
  if (!model || model.length > 1024) {
    return
  }
  useServerState.setState((state) => ({
    manualModels: [...new Set([...state.manualModels, model])],
  }))
  chooseModel(model)
}

export const chooseEffort = (effort: ReasoningEffort) => {
  useServerState.setState((state) => ({
    effort,
    efforts: new Map(state.efforts).set(state.model, effort),
  }))
}

export const serverFetch = async (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  if (init.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json')
    headers.set('X-Chat-Demo', '1')
  }
  const response = await fetch(url, { ...init, headers })
  if (response.status === 401) {
    useServerState.setState({ auth: 'signed-out' })
  }
  return response
}

export const serverRequest = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const response = await serverFetch(url, init)
  const result = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    throw new Error(result?.error ?? `HTTP ${response.status}`)
  }
  return result
}

export const getModels = async () => {
  const config = useServerState.getState().config
  const { models } = await serverRequest<{ models: string[] }>('/api/models')
  if (useServerState.getState().config === config) {
    useServerState.setState({ models })
  }
}

const restoreModelSelection = (config: ServerConfig) => {
  useServerState.setState({ model: '', effort: 'default', efforts: new Map() })
  const presetsList = config.modelPresets ?? []
  const preferredPreset = storedPreference('chat-demo:model-preset')
  const preset =
    presetsList.find(
      (p) =>
        modelPresetKey(p) === preferredPreset ||
        ((p.searchStrength ?? 'off') === 'off' &&
          JSON.stringify([p.model, p.effort]) === preferredPreset)
    ) ?? presetsList[0]
  if (preset) {
    selectModelPreset(preset)
  }
}

export const loadServerSettings = async () => {
  const [config, { presets }] = await Promise.all([
    serverRequest<ServerConfig>('/api/config'),
    serverRequest<{ presets: PromptPreset[] }>('/api/presets'),
  ])
  useServerState.setState({ config, presets, models: [], manualModels: [] })
  restoreModelSelection(config)
  const preferredMode = storedPreference('chat-demo:provider')
  useServerState.setState({
    mode: config.baseUrl && preferredMode !== 'deepseek' ? 'openai' : 'deepseek',
  })
  if (config.baseUrl) {
    void getModels().catch(() => undefined)
  }
}

export const saveServerConfig = async (
  fields: Partial<Pick<ServerConfig, 'baseUrl'>> & {
    password?: string
    apiKey?: string
  }
) => {
  const oldConfig = useServerState.getState().config
  const config = await serverRequest<ServerConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(fields),
  })
  if (fields.password) {
    location.reload()
    return
  }
  const endpointChanged = oldConfig?.baseUrl !== config.baseUrl
  useServerState.setState(endpointChanged ? { config, models: [], manualModels: [] } : { config })
  if (endpointChanged) {
    restoreModelSelection(config)
  }
  if (!config.baseUrl) {
    setProvider('deepseek')
  }
  if (config.baseUrl && (endpointChanged || fields.apiKey)) {
    void getModels().catch(() => undefined)
  }
}

export const changeModelPreset = async (preset: ModelPreset, remove = false) => {
  const config = await serverRequest<ServerConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(remove ? { removeModelPreset: preset } : { addModelPreset: preset }),
  })
  if (!Array.isArray(config.modelPresets)) {
    throw new Error('Restart the server to enable model presets.')
  }
  useServerState.setState({ config })
  if (!remove) {
    selectModelPreset(preset)
  } else if (storedPreference('chat-demo:model-preset') === modelPresetKey(preset)) {
    setPreference('chat-demo:model-preset', '')
  }
}

export const changePreset = async (id: string, preset?: Omit<PromptPreset, 'id'>) => {
  const { presets } = await serverRequest<{ presets: PromptPreset[] }>(
    `/api/presets/${encodeURIComponent(id)}`,
    preset ? { method: 'PUT', body: JSON.stringify(preset) } : { method: 'DELETE' }
  )
  useServerState.setState({ presets })
}
