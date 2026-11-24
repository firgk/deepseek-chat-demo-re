import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HttpError, isObject } from './http.mjs'

const conflict = () => new HttpError(409, 'The conversation changed on another client.')
const validVersion = (value) => Number.isSafeInteger(value) && value > 0

function validateSession(session, id) {
  if (
    !isObject(session) ||
    session.id !== id ||
    typeof session.title !== 'string' ||
    !Number.isFinite(session.createdAt) ||
    !Number.isFinite(session.updatedAt) ||
    !Array.isArray(session.messages) ||
    session.messages.some((message) => !isObject(message))
  ) {
    throw new HttpError(400, 'Invalid conversation.')
  }
}

export function validateSessionId(id) {
  if (
    typeof id !== 'string' ||
    !id ||
    id === '.' ||
    id === '..' ||
    !id.isWellFormed() ||
    /[/\\]/u.test(id) ||
    id.includes('\0')
  ) {
    throw new HttpError(400, 'Invalid conversation ID.')
  }
  return id
}

export function validatePresetId(id) {
  validateSessionId(id)
  if (id.length > 256 || /\p{Cc}/u.test(id)) {
    throw new HttpError(400, 'Invalid preset ID.')
  }
  return id
}

function summarize(session) {
  const { id, title, createdAt, updatedAt } = session
  return { id, title, createdAt, updatedAt }
}

export function openStore(path) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  }
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS collection (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO collection (id, revision) VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      data TEXT,
      summary TEXT
    );
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      text TEXT NOT NULL
    );
  `)
  const revision = db.prepare('SELECT revision FROM collection WHERE id = 1')
  const advanceRevision = db.prepare(
    'UPDATE collection SET revision = revision + 1 WHERE id = 1 RETURNING revision'
  )
  const entries = db.prepare('SELECT id, version, summary FROM sessions ORDER BY id')
  const allSessions = db.prepare('SELECT id, version, data FROM sessions')
  const selectSession = db.prepare('SELECT version, data FROM sessions WHERE id = ?')
  const saveSession = db.prepare(`
    INSERT INTO sessions (id, version, data, summary) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET version = excluded.version,
      data = excluded.data, summary = excluded.summary
  `)
  const presets = db.prepare('SELECT id, name, text FROM presets ORDER BY name, id')
  const savePreset = db.prepare(`
    INSERT INTO presets (id, name, text) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, text = excluded.text
  `)
  const deletePreset = db.prepare('DELETE FROM presets WHERE id = ?')

  function transaction(callback, begin = 'BEGIN IMMEDIATE') {
    db.exec(begin)
    try {
      const result = callback()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function listSessions() {
    return {
      revision: revision.get().revision,
      items: entries
        .all()
        .map(({ id, version, summary }) =>
          summary === null
            ? { id, version, deleted: true }
            : { id, version, deleted: false, summary: JSON.parse(summary) }
        ),
    }
  }

  function listPresets() {
    return { presets: presets.all() }
  }

  return {
    close: () => db.close(),
    listSessions: () => transaction(listSessions, 'BEGIN'),
    getSession(id) {
      const row = selectSession.get(id)
      if (!row?.data) {
        throw new HttpError(404, 'Conversation not found.')
      }
      return { version: row.version, session: JSON.parse(row.data) }
    },
    putSession(id, { version, session }) {
      if (version !== null && !validVersion(version)) {
        throw new HttpError(400, 'Invalid conversation version.')
      }
      validateSession(session, id)
      return transaction(() => {
        const previous = selectSession.get(id)
        if (version === null ? previous : !previous?.data || previous.version !== version) {
          throw conflict()
        }
        const next = (previous?.version ?? 0) + 1
        saveSession.run(id, next, JSON.stringify(session), JSON.stringify(summarize(session)))
        return { version: next, revision: advanceRevision.get().revision }
      })
    },
    deleteSession(id, { version }) {
      if (!validVersion(version)) {
        throw new HttpError(400, 'Invalid conversation version.')
      }
      return transaction(() => {
        const previous = selectSession.get(id)
        if (!previous?.data || previous.version !== version) {
          throw conflict()
        }
        const next = previous.version + 1
        saveSession.run(id, next, null, null)
        return { version: next, revision: advanceRevision.get().revision }
      })
    },
    replaceSessions(body) {
      if (
        !Number.isSafeInteger(body.revision) ||
        body.revision < 0 ||
        !Array.isArray(body.sessions)
      ) {
        throw new HttpError(400, 'Invalid conversation collection.')
      }
      const incoming = new Map()
      for (const session of body.sessions) {
        const id = validateSessionId(session?.id)
        validateSession(session, id)
        if (incoming.has(id)) {
          throw new HttpError(400, 'Duplicate conversation ID.')
        }
        incoming.set(id, session)
      }
      return transaction(() => {
        if (revision.get().revision !== body.revision) {
          throw conflict()
        }
        for (const { id, version, data } of allSessions.all()) {
          const session = incoming.get(id)
          if (session) {
            const nextData = JSON.stringify(session)
            if (nextData !== data) {
              saveSession.run(id, version + 1, nextData, JSON.stringify(summarize(session)))
            }
            incoming.delete(id)
          } else if (data !== null) {
            saveSession.run(id, version + 1, null, null)
          }
        }
        for (const [id, session] of incoming) {
          saveSession.run(id, 1, JSON.stringify(session), JSON.stringify(summarize(session)))
        }
        advanceRevision.get()
        return listSessions()
      })
    },
    listPresets,
    putPreset(id, { name, text }) {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.length > 300 ||
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > 500_000
      ) {
        throw new HttpError(400, 'Invalid system prompt preset.')
      }
      savePreset.run(id, name.trim(), text)
      return listPresets()
    },
    deletePreset(id) {
      deletePreset.run(id)
      return listPresets()
    },
  }
}
