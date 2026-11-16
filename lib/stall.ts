import { Transform, type TransformCallback } from 'node:stream'

export const stallOptions = {
  /** a download that receives no data for this long is aborted */
  timeoutMs: 5 * 60 * 1000
}

export class DownloadStalledError extends Error {
  constructor (timeoutMs: number) {
    super(`download stalled: no data received for ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'DownloadStalledError'
  }
}

/**
 * Pass-through stream that fails when no chunk goes through it for `timeoutMs`.
 *
 * Neither the remote servers nor the clients (axios once the headers are received,
 * ftp and sftp once the transfer started) abort a transfer that stopped moving:
 * without this guard a stalled source keeps the run alive until it is killed.
 * The timer starts at creation, so the guard also covers the wait for the first byte.
 */
export class StallGuard extends Transform {
  private timer: NodeJS.Timeout | undefined
  private readonly timeoutMs: number

  constructor (timeoutMs = stallOptions.timeoutMs) {
    super()
    this.timeoutMs = timeoutMs
    this.arm()
  }

  private arm () {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.destroy(new DownloadStalledError(this.timeoutMs)), this.timeoutMs)
  }

  _transform (chunk: any, _encoding: BufferEncoding, callback: TransformCallback) {
    this.arm()
    callback(null, chunk)
  }

  _flush (callback: TransformCallback) {
    clearTimeout(this.timer)
    callback()
  }

  _destroy (err: Error | null, callback: (error?: Error | null) => void) {
    clearTimeout(this.timer)
    callback(err)
  }
}
