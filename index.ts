import type { PrepareFunction, ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from './types/processingConfig/index.ts'

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  const { run } = await import('./lib/transfer.ts')
  return await run(context)
}

export const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  const stars = '********'
  const password = processingConfig.password
  if (password && password !== stars) {
    secrets.password = password
    processingConfig.password = stars
  } else if (secrets?.secretField && !password) {
    delete secrets.secretField
  }
  const sshKey = processingConfig.sshKey
  if (sshKey && sshKey !== stars) {
    secrets.sshKey = sshKey
    processingConfig.sshKey = stars
  } else if (secrets?.sshKey && !sshKey) {
    delete secrets.sshKey
  }

  return {
    processingConfig,
    secrets
  }
}
