import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'

export const finalizeOptions = {
  /** data-fair processes the file asynchronously: the run waits for it this long at most */
  timeoutMs: 60 * 60 * 1000
}

const STOPPED = Symbol('stopped')

export interface FinalizationWatch {
  /** settles once data-fair is done with the file; throws when the file was not published */
  done: () => Promise<void>
}

/**
 * Follow the journal of a dataset until data-fair is done with the uploaded file.
 *
 * The upload only queues the file: parsing, the schema compatibility check and the
 * validation rules all run afterwards in a data-fair worker. Without waiting for them,
 * a file that data-fair rejects would leave the run green while the dataset still shows
 * its old data.
 *
 * Journal events:
 * - `validation-error` without diagnostic file: breaking schema changes. It does not end
 *   the wait: with `?draft=compatibleOrCancel` a `draft-cancelled` follows, with
 *   `?draft=always` (forceUpdate) the file is published anyway;
 * - `draft-cancelled`: data-fair rejected the new file (breaking schema changes, lines
 *   breaking the validation rules or the primary key), the dataset keeps its data;
 * - `validation-error` with a diagnostic file: lines break the validation rules of a
 *   dataset updated without draft check, it is left in error and nothing follows;
 * - `error`: data-fair could not process the file;
 * - `finalize-end`: the file is published.
 *
 * Call it before the upload when the dataset id is known, so that no event is missed.
 */
export const watchFinalization = (
  ws: ProcessingContext['ws'],
  log: ProcessingContext['log'],
  datasetId: string,
  opts: { forceUpdate?: boolean, stopSignal: Promise<void> }
): FinalizationWatch => {
  const retries: string[] = []
  let breakingChanges: string | undefined
  const eventPromise = ws.waitFor(`datasets/${datasetId}/journal`, (event: any) => {
    if (event.type === 'error-retry') {
      retries.push(event.data)
      return false
    }
    if (event.type === 'validation-error' && !event.hasDiagnosticFile) {
      breakingChanges = event.data
      return false
    }
    return ['finalize-end', 'validation-error', 'error', 'draft-cancelled'].includes(event.type)
  }, finalizeOptions.timeoutMs)
  // the upload may fail before done() is awaited: never leave this promise unhandled
  eventPromise.catch(() => {})

  const done = async () => {
    let event: any
    try {
      event = await Promise.race([eventPromise, opts.stopSignal.then(() => STOPPED)])
    } catch (err: any) {
      if (!err.message?.startsWith('Timeout of')) throw err
      await log.warning(`data-fair is still processing the file after ${Math.round(finalizeOptions.timeoutMs / 60000)} min, the run does not wait any longer: check the dataset page`)
      return
    }
    if (event === STOPPED) {
      await log.warning('run stopped while data-fair was processing the file, its result is not checked')
      return
    }
    for (const retry of retries) await log.warning(`data-fair failed to process the file and will retry: ${retry}`)

    if (event.type === 'error') {
      throw new Error(`data-fair could not process the file: ${event.data}`)
    }
    if (event.type === 'draft-cancelled') {
      if (breakingChanges) {
        throw new Error(`${breakingChanges}. The new file was rejected and the dataset keeps its previous data: enable the "Force the schema update" option if the file must always be published.`)
      }
      const diagnostic = event.hasDiagnosticFile ? ` (error report: api/v1/datasets/${datasetId}/cancelled-draft-diagnostic.csv)` : ''
      throw new Error(`the new file was rejected and the dataset keeps its previous data: ${event.data}${diagnostic}`)
    }
    if (event.type === 'validation-error') {
      throw new Error(`the file does not respect the validation rules of the dataset: ${event.data}`)
    }
    if (breakingChanges) await log.warning(`${breakingChanges}. The schema update is forced, the dataset is updated anyway.`)
    if (event.draft) {
      throw new Error('the new file is kept as a draft and the dataset still shows its previous data: validate or cancel the draft from the dataset page.')
    }
    await log.info('data-fair processed the file, the dataset is up to date')
  }

  return { done }
}
