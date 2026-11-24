export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function json(response, value, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(JSON.stringify(value))
}

export const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export async function readJson(request, limit, allowEmpty) {
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
  if (type !== 'application/json' || request.headers['x-chat-demo'] !== '1') {
    throw new HttpError(403, 'A same-origin JSON request is required.')
  }
  if (Number(request.headers['content-length']) > limit) {
    throw new HttpError(413, 'The request is too large.')
  }
  const chunks = []
  let size = 0
  // Leave the socket available for a 413 response when chunked uploads exceed the limit.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      request.resume()
      throw new HttpError(413, 'The request is too large.')
    }
    chunks.push(chunk)
  }
  if (!size && allowEmpty) {
    return {}
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'Invalid JSON.')
  }
  if (!isObject(body)) {
    throw new HttpError(400, 'Expected a JSON object.')
  }
  return body
}
