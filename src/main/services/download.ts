import { createWriteStream, existsSync, promises as fs, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { net } from 'electron'

export interface DownloadProgress {
  received: number
  total: number
}

function discard(part: string): void {
  rmSync(part, { force: true })
}

/**
 * Stream `url` to `dest`.
 *
 * A completed file is never re-downloaded. Anything interrupted (abort, disk
 * error, truncated body) removes the `.part` file and leaves the caller a real
 * error to show, instead of a half-written file the next run would trust.
 */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  if (existsSync(dest)) return
  if (signal?.aborted) throw new Error('أُلغي التنزيل')
  await fs.mkdir(dirname(dest), { recursive: true })
  const response = await net.fetch(url, { signal, redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`)
  }
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const part = dest + '.part'
  const file = createWriteStream(part)
  const body = Readable.fromWeb(response.body as never)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.({ received, total })
  })

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      file.destroy()
      body.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    body.on('error', fail)
    file.on('error', fail)
    file.on('finish', resolve)
    body.pipe(file)
  }).catch(async (error: unknown) => {
    // Wait for the descriptor to close: deleting `.part` before the stream has
    // opened it can leave a fresh zero-byte file behind.
    await closed(file)
    discard(part)
    throw error
  })

  try {
    // A dropped connection can end the stream "cleanly"; the length is the
    // only proof we got the whole artifact and a truncated installer is worse
    // than a clear failure.
    if (total > 0 && received < total) {
      throw new Error(`download incomplete (${received}/${total} bytes) for ${url}`)
    }
    await fs.rename(part, dest)
  } catch (error) {
    await closed(file)
    discard(part)
    throw error
  }
}

function closed(stream: {
  closed: boolean
  destroy: () => void
  once: (event: 'close', listener: () => void) => unknown
}): Promise<void> {
  return new Promise((resolve) => {
    if (stream.closed) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, 1_000)
    timer.unref?.()
    stream.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    stream.destroy()
  })
}

export async function downloadText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await net.fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`request failed (${response.status})`)
  return response.text()
}

export function partPath(dest: string): string {
  return `${dest}.part`
}
