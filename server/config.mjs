import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { HttpError } from './http.mjs'
import { validateSearchStrength } from './search-policy.mjs'

export const DEFAULT_SYSTEM_PROMPT = '你是一个 AI 问答助手。'

const KEYS = {
  password: 'SITE_PASSWORD',
  baseUrl: 'OPENAI_BASE_URL',
  apiKey: 'OPENAI_API_KEY',
  systemPrompt: 'OPENAI_SYSTEM_PROMPT',
  modelPresets: 'OPENAI_MODEL_PRESETS',
}

function validate(field, value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new HttpError(400, 'Invalid ' + KEYS[field] + '.')
  }
  const trimmed = value.trim()
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

function validateSystemPrompt(value) {
  if (
    typeof value !== 'string' ||
    value.length > 10000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  ) {
    throw new HttpError(400, 'Invalid OPENAI_SYSTEM_PROMPT (maximum 10000 characters).')
  }
  return value.replace(/\r\n?/g, '\n')
}

function readSystemPrompt(value) {
  if (value === undefined) return DEFAULT_SYSTEM_PROMPT
  // Plain single-line text or a JSON string for multiline text.
  if (value.trimStart().startsWith('"')) {
    try {
      return validateSystemPrompt(JSON.parse(value))
    } catch {
      throw new HttpError(400, 'Invalid OPENAI_SYSTEM_PROMPT JSON string.')
    }
  }
  return validateSystemPrompt(value)
}

function validateModelPreset(value) {
  const model = typeof value?.model === 'string' ? value.model.trim() : ''
  if (!model || model.length > 1024 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value.model)) {
    throw new HttpError(400, 'Invalid preset model.')
  }
  if (
    !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort)
  ) {
    throw new HttpError(400, 'Invalid preset reasoning effort.')
  }
  return {
    model,
    effort: value.effort,
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

async function readConfigValues(path) {
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
  return values
}

export async function loadConfig(path) {
  const values = await readConfigValues(path)
  return Object.fromEntries(
    Object.entries(KEYS).map(([field, key]) => [
      field,
      field === 'modelPresets'
        ? readModelPresets(values.get(key))
        : field === 'systemPrompt'
          ? readSystemPrompt(values.get(key))
          : validate(field, values.get(key) || ''),
    ])
  )
}

// Listener settings are startup-only; web settings must not overwrite them.
export async function loadListenOptions(path, env = process.env) {
  const values = await readConfigValues(path)
  const host = (env.HOST || values.get('HOST') || '127.0.0.1').trim()
  const rawPort = (env.PORT || values.get('PORT') || '3000').trim()
  const port = Number(rawPort)
  if (!host || /[\s/\\]/u.test(host)) {
    throw new Error('Invalid HOST. Enter a listen address or hostname.')
  }
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PORT. Enter an integer from 1 to 65535.')
  }
  return { host, port }
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
    systemPrompt:
      body.systemPrompt === undefined
        ? current.systemPrompt
        : validateSystemPrompt(body.systemPrompt),
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
        field === 'modelPresets'
          ? JSON.stringify(config[field] ?? [])
          : field === 'systemPrompt'
            ? JSON.stringify(config[field] ?? DEFAULT_SYSTEM_PROMPT)
            : config[field],
      ])
    )
    const updated = new Set()
    const contents = []
    for (const line of old.replace(/\r?\n$/, '').split(/\r?\n/)) {
      const key = line.slice(0, line.indexOf('=')).trim()
      if (key === 'OPENAI_DEFAULT_MODEL' || key === 'OPENAI_DEFAULT_REASONING_EFFORT') {
        continue
      }
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

export const publicConfig = ({ baseUrl, modelPresets, systemPrompt, apiKey }) => ({
  baseUrl,
  modelPresets,
  systemPrompt,
  hasApiKey: Boolean(apiKey),
})

export function passwordMatches(expected, supplied) {
  if (typeof supplied !== 'string') {
    return false
  }
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(expected), digest(supplied))
}
