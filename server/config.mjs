import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { HttpError } from './http.mjs'
import { validateSearchStrength } from './search-policy.mjs'

const KEYS = {
  password: 'SITE_PASSWORD',
  baseUrl: 'OPENAI_BASE_URL',
  apiKey: 'OPENAI_API_KEY',
  defaultModel: 'OPENAI_DEFAULT_MODEL',
  defaultReasoningEffort: 'OPENAI_DEFAULT_REASONING_EFFORT',
  modelPresets: 'OPENAI_MODEL_PRESETS',
}

function validate(field, value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new HttpError(400, 'Invalid ' + KEYS[field] + '.')
  }
  const trimmed = value.trim()
  if (field === 'defaultReasoningEffort') {
    if (
      !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(trimmed)
    ) {
      throw new HttpError(400, 'Invalid OPENAI_DEFAULT_REASONING_EFFORT.')
    }
    return trimmed
  }
  if (field === 'password' && (!trimmed || trimmed.length > 1024)) {
    throw new HttpError(400, 'Enter a site password between 1 and 1024 characters.')
  }
  if (field === 'apiKey' && !/^[!-~]*$/.test(trimmed)) {
    throw new HttpError(400, 'Invalid OPENAI_API_KEY.')
  }
  if (field === 'baseUrl' && trimmed) {
    let url
    try {
      url = new URL(trimmed)
    } catch {
      throw new HttpError(400, 'Enter a valid HTTP or HTTPS OpenAI base URL.')
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new HttpError(
        400,
        'The OpenAI base URL must use HTTP or HTTPS without credentials, queries or fragments.'
      )
    }
    return url.href.replace(/\/+$/, '')
  }
  return trimmed
}

function validateModelPreset(value) {
  const model = validate('defaultModel', value?.model)
  if (!model || model.length > 1024) {
    throw new HttpError(400, 'Invalid preset model.')
  }
  return {
    model,
    effort: validate('defaultReasoningEffort', value.effort),
    searchStrength: validateSearchStrength(
      value.searchStrength === undefined ? 'off' : value.searchStrength
    ),
  }
}

const samePreset = (a, b) =>
  a.model === b.model &&
  a.effort === b.effort &&
  (a.searchStrength ?? 'off') === (b.searchStrength ?? 'off')

function readModelPresets(value) {
  let items
  try {
    items = JSON.parse(value || '[]')
  } catch {
    throw new HttpError(400, 'Invalid OPENAI_MODEL_PRESETS.')
  }
  if (!Array.isArray(items) || items.length > 100) {
    throw new HttpError(400, 'Invalid OPENAI_MODEL_PRESETS.')
  }
  const presets = []
  for (const item of items.map(validateModelPreset)) {
    if (!presets.some((p) => samePreset(p, item))) presets.push(item)
  }
  return presets
}

export async function loadConfig(path) {
  let source
  try {
    source = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      'Unable to read .config. Copy .config_example to .config and set SITE_PASSWORD.'
    )
  }
  const values = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue
    }
    const index = line.indexOf('=')
    if (index === -1) {
      continue
    }
    values.set(line.slice(0, index).trim(), line.slice(index + 1))
  }
  return Object.fromEntries(
    Object.entries(KEYS).map(([field, key]) => [
      field,
      field === 'modelPresets'
        ? readModelPresets(values.get(key))
        : validate(field, values.get(key) || (field === 'defaultReasoningEffort' ? 'default' : '')),
    ])
  )
}

export function editConfig(current, body) {
  const baseUrl = body.baseUrl === undefined ? current.baseUrl : validate('baseUrl', body.baseUrl)
  if (baseUrl && baseUrl !== current.baseUrl && body.apiKey === undefined) {
    throw new HttpError(
      400,
      'Enter the API key for the new OpenAI base URL, or explicitly choose no API key.'
    )
  }
  let modelPresets = current.modelPresets ?? []
  if (body.addModelPreset !== undefined) {
    const preset = validateModelPreset(body.addModelPreset)
    if (!modelPresets.some((p) => samePreset(p, preset))) {
      if (modelPresets.length >= 100)
        throw new HttpError(400, 'At most 100 model presets are allowed.')
      modelPresets = [...modelPresets, preset]
    }
  }
  if (body.removeModelPreset !== undefined) {
    const preset = validateModelPreset(body.removeModelPreset)
    modelPresets = modelPresets.filter((p) => !samePreset(p, preset))
  }
  return {
    baseUrl,
    modelPresets,
    defaultModel:
      body.defaultModel === undefined
        ? current.defaultModel
        : validate('defaultModel', body.defaultModel),
    defaultReasoningEffort: validate(
      'defaultReasoningEffort',
      body.defaultReasoningEffort === undefined
        ? (current.defaultReasoningEffort ?? 'default')
        : body.defaultReasoningEffort
    ),
    apiKey: body.apiKey === undefined ? current.apiKey : validate('apiKey', body.apiKey),
    password: body.password === undefined ? current.password : validate('password', body.password),
  }
}

export async function writeConfig(path, config) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    const old = await readFile(path, 'utf8')
    const values = new Map(
      Object.entries(KEYS).map(([field, key]) => [
        key,
        field === 'modelPresets' ? JSON.stringify(config[field] ?? []) : config[field],
      ])
    )
    const updated = new Set()
    const contents = []
    for (const line of old.replace(/\r?\n$/, '').split(/\r?\n/)) {
      const key = line.slice(0, line.indexOf('=')).trim()
      if (!line.includes('=') || !values.has(key)) {
        contents.push(line)
      } else if (!updated.has(key)) {
        contents.push(key + '=' + values.get(key))
        updated.add(key)
      }
    }
    for (const [key, value] of values) {
      if (!updated.has(key)) {
        contents.push(key + '=' + value)
      }
    }
    await writeFile(temp, contents.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } catch {
    await rm(temp, { force: true }).catch(() => {})
    throw new HttpError(500, 'Unable to write .config.')
  }
}

export const publicConfig = ({
  baseUrl,
  defaultModel,
  defaultReasoningEffort,
  modelPresets,
  apiKey,
}) => ({
  baseUrl,
  defaultModel,
  defaultReasoningEffort,
  modelPresets,
  hasApiKey: Boolean(apiKey),
})

export function passwordMatches(expected, supplied) {
  if (typeof supplied !== 'string') {
    return false
  }
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(supplied))
}
