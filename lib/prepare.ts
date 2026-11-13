import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

const stars = '********'

/**
 * Move the credentials out of the config into the secrets store: the config keeps
 * a mask, an emptied field removes the stored secret.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  for (const key of ['password', 'sshKey'] as const) {
    const value = processingConfig[key]
    if (value && value !== stars) {
      secrets[key] = value
      processingConfig[key] = stars
    } else if (!value && secrets?.[key]) {
      delete secrets[key]
    }
  }
  return { processingConfig, secrets }
}

export default prepare
