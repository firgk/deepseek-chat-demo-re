import { create } from 'zustand'
import { serverFetch } from '../serverState.js'
import type { Session, SessionSummary } from './types.js'

export type HistoryItem = {
  id: string
  version: number
} & ({ deleted: true } | { deleted: false; summary: SessionSummary })

type HistoryList = { revision: number; items: HistoryItem[] }
type HistoryDetail = { version: number; session: Session }
type HistoryWrite = { version: number; revision: number }

export const useHistoryConflict = create<boolean>(() => false)

const conflict = () => {
  useHistoryConflict.setState(true, true)
  return new Error('History changed on the server. Refresh the page to continue.')
}

const checkConflict = () => {
  if (useHistoryConflict.getState()) {
    throw conflict()
  }
}

const collectionUrl = '/api/sessions'
const sessionUrl = (id: string) => `${collectionUrl}/${encodeURIComponent(id)}`

const request = async <T>(url: string, method?: 'PUT' | 'DELETE', body?: unknown): Promise<T> => {
  const response = await serverFetch(url, method && { method, body: JSON.stringify(body) })
  if (response.status === 409) {
    throw conflict()
  }
  if (response.status === 404 && !method && url !== collectionUrl) {
    throw conflict()
  }
  if (!response.ok) {
    throw new Error(`History request failed (${response.status})`)
  }
  return (await response.json()) as T
}

let queue: Promise<unknown> = Promise.resolve()
const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
  const task = queue.then(run)
  queue = task.catch(() => {})
  return task
}

let snapshot: { revision: number | null; items: Map<string, HistoryItem> } | undefined
const loaded = new Set<string>()

const current = () => {
  if (!snapshot) {
    throw new Error('Server history has not been loaded')
  }
  return snapshot
}

const summariesFrom = (items: Iterable<HistoryItem>) =>
  Array.from(items).flatMap((item) => (item.deleted ? [] : [item.summary]))

const setSnapshot = ({ revision, items }: HistoryList) => {
  snapshot = { revision, items: new Map(items.map((item) => [item.id, item])) }
  loaded.clear()
  return summariesFrom(items)
}

export const loadRemoteSummaries = (
  readLocalSessions: () => Promise<Session[]>,
  mirrorList?: (items: HistoryItem[]) => Promise<void>
) =>
  enqueue(async () => {
    if (snapshot) {
      return summariesFrom(snapshot.items.values())
    }
    checkConflict()
    let list = await request<HistoryList>(collectionUrl)
    const known = new Set(list.items.map((item) => item.id))
    const missing = (await readLocalSessions()).filter((session) => !known.has(session.id))
    for (const session of missing) {
      // A null version creates the record only if it still has no live record or tombstone.
      const response = await serverFetch(sessionUrl(session.id), {
        method: 'PUT',
        body: JSON.stringify({ version: null, session }),
      })
      // Another device may have migrated or deleted this ID after our initial
      // list. No local edits have started: adopt the server's record/tombstone.
      if (!response.ok && response.status !== 409) {
        throw new Error(`History request failed (${response.status})`)
      }
    }
    if (missing.length > 0) {
      // Nothing is displayed yet, so we can adopt the whole list after migration.
      list = await request<HistoryList>(collectionUrl)
    }
    await mirrorList?.(list.items)
    return setSnapshot(list)
  })

const readSession = async (id: string): Promise<Session | undefined> => {
  const item = current().items.get(id)
  if (!item || item.deleted) {
    return undefined
  }
  const { version, session } = await request<HistoryDetail>(sessionUrl(id))
  // The UI already holds the list metadata for item.version. Accepting another
  // version here could merge old metadata into the newer session on save.
  if (version !== item.version) {
    throw conflict()
  }
  loaded.add(id)
  return session
}

type MirrorSession = (session: Session) => Promise<void>

export const loadRemoteSession = (id: string, mirrorSession?: MirrorSession) =>
  enqueue(async () => {
    const session = await readSession(id)
    if (session) {
      await mirrorSession?.(session)
    }
    return session
  })

const recordWrite = (result: HistoryWrite, item: HistoryItem) => {
  const state = current()
  state.items.set(item.id, item)
  // This response only describes one item. A gap invalidates the baseline
  // for collection writes, even when individual item versions are usable.
  state.revision =
    state.revision !== null && result.revision === state.revision + 1 ? result.revision : null
}

const writeSession = async (session: Session) => {
  const { id, title, createdAt, updatedAt } = session
  const item = current().items.get(id)
  if (item && (item.deleted || !loaded.has(id))) {
    throw conflict()
  }
  const result = await request<HistoryWrite>(sessionUrl(id), 'PUT', {
    version: item?.version ?? null,
    session,
  })
  recordWrite(result, {
    id,
    version: result.version,
    deleted: false,
    summary: { id, title, createdAt, updatedAt },
  })
  loaded.add(id)
}

export const saveRemoteSession = (
  session: Session,
  storeFiles?: () => Promise<void>,
  mirrorSession?: MirrorSession
) =>
  enqueue(async () => {
    await storeFiles?.()
    checkConflict()
    await writeSession(session)
    await mirrorSession?.(session)
  })

export const renameRemoteSession = (id: string, title: string, mirrorSession?: MirrorSession) =>
  enqueue(async () => {
    checkConflict()
    const session = await readSession(id)
    if (!session) {
      throw conflict()
    }
    const renamed = { ...session, title }
    await writeSession(renamed)
    await mirrorSession?.(renamed)
  })

export const deleteRemoteSession = (id: string, removeMirror?: (id: string) => Promise<void>) =>
  enqueue(async () => {
    checkConflict()
    const item = current().items.get(id)
    if (!item) {
      return
    }
    if (item.deleted) {
      throw conflict()
    }
    const result = await request<HistoryWrite>(sessionUrl(id), 'DELETE', { version: item.version })
    recordWrite(result, { id, version: result.version, deleted: true })
    loaded.delete(id)
    await removeMirror?.(id)
  })

export const replaceRemoteSessions = (
  readStagedSessions: () => Promise<Session[]>,
  commitLocalStaging: () => Promise<unknown>
) =>
  enqueue(async () => {
    checkConflict()
    const { revision } = current()
    if (revision === null) {
      throw conflict()
    }
    const sessions = await readStagedSessions()
    const list = await request<HistoryList>(collectionUrl, 'PUT', { revision, sessions })
    try {
      await commitLocalStaging()
    } catch (error) {
      // The server has committed. Prevent the caller's previous in-memory history
      // from being written back while reporting the local failure.
      conflict()
      throw error
    }
    return setSnapshot(list)
  })
