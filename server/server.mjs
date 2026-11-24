import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { editConfig, loadConfig, passwordMatches, publicConfig, writeConfig } from './config.mjs'
import { openStore, validatePresetId, validateSessionId } from './database.mjs'
import { HttpError, json, readJson } from './http.mjs'
import { listModels, streamChat } from './openai.mjs'
import { serveStatic } from './static.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const COOKIE_NAME = 'chat_demo_session'
const SESSION_SECONDS = 7 * 24 * 60 * 60
const LOGIN_WINDOW = 15 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 5

function sessionCookie(request, token, age) {
  const secure =
    request.socket.encrypted ||
    request.headers['x-forwarded-proto']?.split(',')[0].trim() === 'https'
  return (
    COOKIE_NAME +
    '=' +
    token +
    '; Path=/; Max-Age=' +
    age +
    '; HttpOnly; SameSite=Strict' +
    (secure ? '; Secure' : '')
  )
}

function cookieToken(request) {
  const cookies = request.headers.cookie?.split(';') ?? []
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=')
    if (name === COOKIE_NAME) {
      return value
    }
  }
}

function bodyLimit(path) {
  if (path === '/sessions') {
    return 64 * 1024 * 1024
  }
  if (path === '/chat/completions') {
    return 32 * 1024 * 1024
  }
  if (path.startsWith('/sessions/')) {
    return 8 * 1024 * 1024
  }
  if (path.startsWith('/presets/')) {
    return 3 * 1024 * 1024
  }
  return 16 * 1024
}

export async function createChatServer({
  configPath = resolve(ROOT, '.config'),
  databasePath = resolve(ROOT, '.data/chat-demo.sqlite'),
  distPath = resolve(ROOT, 'dist'),
} = {}) {
  let config = await loadConfig(configPath)
  const database = openStore(databasePath)
  const protectedPaths = new Set(
    [configPath, databasePath, databasePath + '-wal', databasePath + '-shm'].map((path) =>
      resolve(path)
    )
  )
  const sessions = new Map()
  const failedLogins = new Map()
  let configUpdates = Promise.resolve()

  function isAuthenticated(token) {
    const expires = sessions.get(token)
    if (expires > Date.now()) {
      return true
    }
    sessions.delete(token)
    return false
  }

  function requireAuth(token) {
    if (!isAuthenticated(token)) {
      throw new HttpError(401, 'Sign in to continue.')
    }
  }

  function login(request, response, body) {
    const ip = request.socket.remoteAddress
    const now = Date.now()
    for (const [key, { expires }] of failedLogins) {
      if (expires <= now) {
        failedLogins.delete(key)
      }
    }
    const attempt = failedLogins.get(ip) ?? { count: 0, expires: now + LOGIN_WINDOW }
    if (attempt.count >= MAX_LOGIN_ATTEMPTS) {
      response.setHeader('Retry-After', Math.ceil((attempt.expires - now) / 1000))
      throw new HttpError(429, 'Too many sign-in attempts. Try again later.')
    }
    if (!passwordMatches(config.password, body.password)) {
      attempt.count += 1
      failedLogins.set(ip, attempt)
      throw new HttpError(401, 'Incorrect password.')
    }
    failedLogins.delete(ip)
    const previous = cookieToken(request)
    sessions.delete(previous)
    for (const [key, expires] of sessions) {
      if (expires <= now) {
        sessions.delete(key)
      }
    }
    const token = randomBytes(32).toString('base64url')
    sessions.set(token, now + SESSION_SECONDS * 1000)
    response.setHeader('Set-Cookie', sessionCookie(request, token, SESSION_SECONDS))
    json(response, { authenticated: true })
  }

  async function updateConfig(token, response, body) {
    const update = configUpdates.then(async () => {
      requireAuth(token)
      const next = editConfig(config, body)
      const changedPassword = next.password !== config.password
      await writeConfig(configPath, next)
      config = next
      if (changedPassword) {
        sessions.clear()
        failedLogins.clear()
        response.setHeader('Set-Cookie', sessionCookie(response.req, '', 0))
      }
      return publicConfig(config)
    })
    configUpdates = update.catch(() => {})
    json(response, await update)
  }

  async function handleApi(request, response, path) {
    const token = cookieToken(request)
    const method = request.method
    if (path === '/auth/session' && method === 'GET') {
      json(response, { authenticated: isAuthenticated(token) })
      return
    }

    const signingIn = path === '/login' && method === 'POST'
    if (!signingIn) {
      requireAuth(token)
    }
    let body
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const allowEmpty =
        (method === 'POST' && path === '/logout') ||
        (method === 'DELETE' && path.startsWith('/presets/'))
      body = await readJson(request, bodyLimit(path), allowEmpty)
      if (!signingIn) {
        requireAuth(token)
      }
    }

    if (signingIn) {
      login(request, response, body)
    } else if (path === '/logout' && method === 'POST') {
      sessions.delete(token)
      response.setHeader('Set-Cookie', sessionCookie(request, '', 0))
      json(response, { authenticated: false })
    } else if (path === '/config' && method === 'GET') {
      json(response, publicConfig(config))
    } else if (path === '/config' && method === 'PUT') {
      await updateConfig(token, response, body)
    } else if (path === '/models' && method === 'GET') {
      json(response, await listModels(config))
    } else if (path === '/chat/completions' && method === 'POST') {
      await streamChat(config, body, response)
    } else if (path === '/sessions' && method === 'GET') {
      json(response, database.listSessions())
    } else if (path === '/sessions' && method === 'PUT') {
      json(response, database.replaceSessions(body))
    } else if (path === '/presets' && method === 'GET') {
      json(response, database.listPresets())
    } else {
      const entry = /^\/(sessions|presets)\/([^/]+)$/.exec(path)
      if (entry) {
        const value = decodeURIComponent(entry[2])
        if (entry[1] === 'sessions') {
          const id = validateSessionId(value)
          if (method === 'GET') {
            return json(response, database.getSession(id))
          }
          if (method === 'PUT') {
            return json(response, database.putSession(id, body))
          }
          if (method === 'DELETE') {
            return json(response, database.deleteSession(id, body))
          }
        } else {
          const id = validatePresetId(value)
          if (method === 'PUT') {
            return json(response, database.putPreset(id, body))
          }
          if (method === 'DELETE') {
            return json(response, database.deletePreset(id))
          }
        }
      }
      throw new HttpError(404, 'API route not found.')
    }
  }

  async function handle(request, response) {
    try {
      const path = new URL(request.url, 'http://localhost').pathname
      if (path.startsWith('/api/') || path === '/api') {
        await handleApi(request, response, path.slice(4))
      } else {
        await serveStatic(request, response, path, distPath, protectedPaths)
      }
    } catch (error) {
      if (response.destroyed) {
        return
      }
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof HttpError) {
        json(response, { error: error.message }, error.status)
      } else if (error instanceof URIError) {
        json(response, { error: 'Invalid URL.' }, 400)
      } else {
        json(response, { error: 'The server could not complete the request.' }, 500)
      }
    }
  }

  const server = createServer(handle)
  server.once('close', () => database.close())
  return server
}
