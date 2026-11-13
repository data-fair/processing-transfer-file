import type { PrepareFunction, RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './types/processingConfig/index.ts'

/**
 * Prepare the processing config (triggered when the config is saved).
 * Moves the password and the SSH key out of the config and into the secrets store.
 */
export const prepare: PrepareFunction<ProcessingConfig> = async (context) => {
  const prepare = (await import('./lib/prepare.ts')).default
  return prepare(context)
}

/**
 * Execute the processing: download a file over HTTP(S), FTP(S) or SFTP and load it
 * into a data-fair dataset.
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  const { run } = await import('./lib/transfer.ts')
  return run(context)
}

export const stop = async () => {
  const { stop } = await import('./lib/transfer.ts')
  return stop()
}
