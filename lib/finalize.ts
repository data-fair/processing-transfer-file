import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'

export const finalizeOptions = {
  /** data-fair processes the file asynchronously: the run waits for it this long at most */
  timeoutMs: 10 * 60 * 1000,
  /** after an `error` journal event, how often the dataset status is read to tell a failure from a notice */
  statusPollMs: 2000
}

const STOPPED = Symbol('stopped')
const FAILED = Symbol('failed')

export interface FinalizationWatch {
  /** settles once data-fair decided on the file; throws when the file was not published */
  done: () => Promise<void>
}

/**
 * Follow the journal of a dataset until data-fair decided on the uploaded file.
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
 * - `draft-validated`: the draft is accepted, the run stops waiting there (indexing goes on);
 * - `finalize-end`: the file is published (new dataset, no draft);
 * - `error`: also used by data-fair for non-blocking notices (empty columns, lines
 *   rejected by elasticsearch). Only a dataset (or draft) left in status `error` without
 *   a pending retry is a failure, so the status is read while waiting for the next event.
 *
 * Call it before the upload when the dataset id is known, so that no event is missed.
 */
export const watchFinalization = (
  ws: ProcessingContext['ws'],
  axios: ProcessingContext['axios'],
  log: ProcessingContext['log'],
  datasetId: string,
  opts: { forceUpdate?: boolean, stopSignal: Promise<void> }
): FinalizationWatch => {
  const retries: string[] = []
  const errors: string[] = []
  let breakingChanges: string | undefined
  let startPolling: (() => void) | undefined
  const eventPromise = ws.waitFor(`datasets/${datasetId}/journal`, (event: any) => {
    if (event.type === 'error-retry') {
      retries.push(event.data)
      return false
    }
    if (event.type === 'error') {
      errors.push(event.data)
      startPolling?.()
      return false
    }
    if (event.type === 'validation-error' && !event.hasDiagnosticFile) {
      breakingChanges = event.data
      return false
    }
    return ['draft-validated', 'finalize-end', 'validation-error', 'draft-cancelled'].includes(event.type)
  }, finalizeOptions.timeoutMs)
  // the upload may fail before done() is awaited: never leave this promise unhandled
  eventPromise.catch(() => {})

  // the worker writes the journal event before the status, so the status is polled
  let settled = false
  const failedPromise = new Promise<typeof FAILED>((resolve, reject) => {
    startPolling = () => {
      startPolling = undefined
      const poll = async () => {
        while (true) {
          await new Promise(resolve => setTimeout(resolve, finalizeOptions.statusPollMs))
          if (settled) return
          const dataset = (await axios.get(`api/v1/datasets/${datasetId}`, { params: { draft: true } })).data
          if (dataset.status === 'error' && !dataset.errorRetry) return resolve(FAILED)
        }
      }
      poll().catch(reject)
    }
    if (errors.length) startPolling()
  })
  failedPromise.catch(() => {})

  const done = async () => {
    let event: any
    try {
      event = await Promise.race([eventPromise, failedPromise, opts.stopSignal.then(() => STOPPED)])
    } catch (err: any) {
      if (!err.message?.startsWith('Timeout of')) throw err
      await log.warning(`data-fair is still processing the file after ${Math.round(finalizeOptions.timeoutMs / 60000)} min, the run does not wait any longer: check the dataset page`)
      return
    } finally {
      settled = true
    }
    if (event === STOPPED) {
      await log.warning('run stopped while data-fair was processing the file, its result is not checked')
      return
    }
    for (const retry of retries) await log.warning(`data-fair failed to process the file and will retry: ${retry}`)

    if (event === FAILED) {
      throw new Error(`data-fair could not process the file: ${errors[errors.length - 1]}`)
    }
    for (const error of errors) await log.warning(`data-fair: ${error}`)
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
    if (event.type === 'finalize-end' && event.draft) {
      throw new Error('the new file is kept as a draft and the dataset still shows its previous data: validate or cancel the draft from the dataset page.')
    }
    await log.info(event.type === 'draft-validated'
      ? 'data-fair accepted the file, the dataset is being updated'
      : 'data-fair processed the file, the dataset is up to date')
  }

  return { done }
}
