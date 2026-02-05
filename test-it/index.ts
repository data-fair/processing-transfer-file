import type { ProcessingConfig } from '../types/processingConfig/index.ts'
import fs from 'fs-extra'
import config from 'config'
import { strict as assert } from 'node:assert'
import { it, describe } from 'node:test'
import nock from 'nock'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as transferFilePlugin from '../index.ts'

const sshKey = fs.readFileSync('test-it/resources/user_keys/id_rsa', 'utf8')

describe('Download file processing', () => {
  it('should download a file over http', async function () {
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test' },
      url: 'https://www.data.gouv.fr/fr/datasets/r/e32f7675-913b-4e01-b8c8-0a29733e4407'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title!.startsWith('Download file test'))
  })

  it('should download a file over sftp', async function () {
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test sftp' },
      // cf https://test.rebex.net/
      url: 'sftp://test.rebex.net/pub/example/readme.txt',
      username: 'demo',
      password: 'password'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title!.startsWith('Download file test sftp'))
  })

  it('should download a file over sftp with private key auth', async function () {
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test sftp with key' },
      url: 'sftp://localhost:31022/landing-zone/test.txt',
      username: 'test3',
      sshKey
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title!.startsWith('Download file test sftp'))
  })

  it('should download a file over sftp with private key auth in secret', async function () {
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test sftp with key' },
      url: 'sftp://localhost:31022/landing-zone/test.txt',
      username: 'test3',
      sshKey: '***'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig, secrets: { sshKey }
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title!.startsWith('Download file test sftp'))
  })

  it('should download a file over ftp', async function () {
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test ftp' },
      // cf https://test.rebex.net/
      url: 'ftp://test.rebex.net/pub/example/readme.txt',
      username: 'demo',
      password: 'password'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title!.startsWith('Download file test ftp'))
  })

  it('should load a line as bulk actions in rest dataset', async function () {
    // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    const { axios } = testUtils.context({ }, config, false)

    try {
      await axios.delete('api/v1/datasets/transfer-file-rest-test')
    } catch (err: any) {
      if (err.status !== 404) throw err
    }
    await new Promise(resolve => setTimeout(resolve, 1000))

    const dataset = (await axios.put('api/v1/datasets/transfer-file-rest-test', {
      isRest: true,
      title: 'transfer-file-rest-test',
      schema: [{ key: 'country', type: 'string' }]
    })).data
    await new Promise(resolve => setTimeout(resolve, 2000))

    nock('https://test.com')
      .get('/lines.csv')
      .reply(200, `country
france
england`)
    const processingConfig: ProcessingConfig = {
      dataset: { title: dataset.title, id: dataset.id },
      datasetMode: 'lines',
      separator: ',',
      url: 'https://test.com/lines.csv'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)

    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'lines')

    const { data } = await context.axios.get('api/v1/datasets/transfer-file-rest-test/lines')
    assert.equal(data.total, 2)
  })
})
