import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { HttpError } from './http.mjs'

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function serveStatic(request, response, pathname, distPath, protectedPaths) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed.')
  }
  if (pathname === '/') {
    pathname = '/index.html'
  }
  const relative = decodeURIComponent(pathname).slice(1)
  if (
    relative.split('/').some((part) => part.startsWith('.')) ||
    relative.includes('\\') ||
    relative.includes('\0')
  ) {
    throw new HttpError(404, 'File not found.')
  }
  let file
  let size
  try {
    const directory = await realpath(distPath)
    file = await realpath(resolve(directory, relative))
    if (!file.startsWith(directory + sep) || protectedPaths.has(file)) {
      throw new Error()
    }
    const metadata = await stat(file)
    if (!metadata.isFile()) {
      throw new Error()
    }
    size = metadata.size
  } catch {
    throw new HttpError(404, 'File not found.')
  }
  const headers = {
    'Content-Type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
  if (relative === 'index.html') {
    const html = await readFile(file, 'utf8')
    const index = html.replace(/<\/head>/i, '<meta name="chat-demo-server" content="1"></head>')
    response.writeHead(200, headers)
    response.end(request.method === 'HEAD' ? undefined : index)
  } else {
    response.writeHead(200, { ...headers, 'Content-Length': size })
    if (request.method === 'HEAD') {
      response.end()
    } else {
      await pipeline(createReadStream(file), response)
    }
  }
}
