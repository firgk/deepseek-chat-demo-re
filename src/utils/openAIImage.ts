import { resizeUploadImage } from './resizeUploadImage.js'

export const MAX_OPENAI_IMAGE_BYTES = 6 * 1024 * 1024

export const imageDataUrl = async (
  blob: Blob,
  name: string,
  mime: string,
  signal?: AbortSignal
) => {
  const file = await resizeUploadImage(new File([blob], name, { type: mime }), signal)
  signal?.throwIfAborted()
  if (file.size > MAX_OPENAI_IMAGE_BYTES) {
    throw new Error('Image exceeds 6 MB after resizing. Please compress it and retry.')
  }
  const data = new Uint8Array(await file.arrayBuffer())
  signal?.throwIfAborted()
  let binary = ''
  for (let i = 0; i < data.length; i += 32768) {
    binary += String.fromCharCode(...data.subarray(i, i + 32768))
  }
  return 'data:' + file.type + ';base64,' + btoa(binary)
}
