import { strict as assert } from 'node:assert'
import { it, describe } from 'node:test'
import * as transferFilePlugin from '../../index.ts'

describe('prepare', () => {
  it('should mask the password and store it in secrets', async () => {
    const processingConfig: any = { password: 'my-password' }
    const secrets: any = {}
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.processingConfig.password, '********')
    assert.equal(result.secrets.password, 'my-password')
  })

  it('should not overwrite an already masked password', async () => {
    const processingConfig: any = { password: '********' }
    const secrets: any = {}
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.processingConfig.password, '********')
    assert.equal(result.secrets.password, undefined)
  })

  it('should delete the secretField when there is no password', async () => {
    const processingConfig: any = {}
    const secrets: any = { secretField: 'my-password' }
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.secrets.secretField, undefined)
  })

  it('should mask the sshKey and store it in secrets', async () => {
    const processingConfig: any = { sshKey: 'my-ssh-key' }
    const secrets: any = {}
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.processingConfig.sshKey, '********')
    assert.equal(result.secrets.sshKey, 'my-ssh-key')
  })

  it('should not overwrite an already masked sshKey', async () => {
    const processingConfig: any = { sshKey: '********' }
    const secrets: any = {}
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.processingConfig.sshKey, '********')
    assert.equal(result.secrets.sshKey, undefined)
  })

  it('should delete the sshKey from secrets when the config sshKey is empty', async () => {
    const processingConfig: any = {}
    const secrets: any = { sshKey: 'my-ssh-key' }
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.secrets.sshKey, undefined)
  })

  it('should mask both password and sshKey', async () => {
    const processingConfig: any = { password: 'my-password', sshKey: 'my-ssh-key' }
    const secrets: any = {}
    const result = await transferFilePlugin.prepare({ processingConfig, secrets } as any)
    assert.equal(result.processingConfig.password, '********')
    assert.equal(result.secrets.password, 'my-password')
    assert.equal(result.processingConfig.sshKey, '********')
    assert.equal(result.secrets.sshKey, 'my-ssh-key')
  })
})
