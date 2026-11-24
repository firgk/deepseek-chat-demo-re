import { create } from 'zustand'
import type { ReasoningEffort } from './composerOptions.js'

export const serverEnabled = () =>
  typeof document !== 'undefined' &&
  document.querySelector('meta[name="chat-demo-server"]') !== null

export type ServerConfig = { baseUrl: string; defaultModel: string; hasApiKey: boolean }
export type PromptPreset = { id: string; name: string; text: string }
type Mode = 'deepseek' | 'openai'
type ServerState = {
  auth: 'checking' | 'signed-out' | 'signed-in'
  mode: Mode
  config: ServerConfig | null
  model: string
  effort: ReasoningEffort
  efforts: ReadonlyMap<string, ReasoningEffort>
  showSelectors: boolean
  models: string[]
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

export const useServerState = create<ServerState>(() => ({
  auth: 'checking',
  mode:
    serverEnabled() && storedPreference('chat-demo:provider') === 'openai' ? 'openai' : 'deepseek',
  config: null,
  model: '',
  effort: 'default',
  efforts: new Map(),
  showSelectors: storedPreference('chat-demo:model-selectors') !== 'false',
  models: [],
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
  useServerState.setState((state) => ({ model, effort: state.efforts.get(model) ?? 'default' }))
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

export const loadServerSettings = async () => {
  const [config, { presets }] = await Promise.all([
    serverRequest<ServerConfig>('/api/config'),
    serverRequest<{ presets: PromptPreset[] }>('/api/presets'),
  ])
  useServerState.setState({ config, model: config.defaultModel, presets })
  const preferredMode = storedPreference('chat-demo:provider')
  useServerState.setState({
    mode: config.baseUrl && preferredMode !== 'deepseek' ? 'openai' : 'deepseek',
  })
  if (config.baseUrl) {
    void getModels().catch(() => undefined)
  }
}

export const saveServerConfig = async (
  fields: Pick<ServerConfig, 'baseUrl' | 'defaultModel'> & { password?: string; apiKey?: string }
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
  const defaultChanged = oldConfig?.defaultModel !== config.defaultModel
  useServerState.setState(endpointChanged ? { config, models: [], efforts: new Map() } : { config })
  if (endpointChanged || defaultChanged) {
    chooseModel(config.defaultModel)
  }
  if (!config.baseUrl) {
    setProvider('deepseek')
  }
  if (config.baseUrl && (endpointChanged || fields.apiKey)) {
    void getModels().catch(() => undefined)
  }
}

export const changePreset = async (id: string, preset?: Omit<PromptPreset, 'id'>) => {
  const { presets } = await serverRequest<{ presets: PromptPreset[] }>(
    `/api/presets/${encodeURIComponent(id)}`,
    preset ? { method: 'PUT', body: JSON.stringify(preset) } : { method: 'DELETE' }
  )
  useServerState.setState({ presets })
}
