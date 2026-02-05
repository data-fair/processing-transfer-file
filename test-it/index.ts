import type { ProcessingConfig } from '../types/processingConfig/index.ts'
import fs from 'fs-extra'
import config from 'config'
import { strict as assert } from 'node:assert'
import { it, describe } from 'node:test'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as transferFilePlugin from '../index.ts'

describe('Download file processing', () => {
  it.only('should download a file over http', async function () {
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test' },
      url: 'https://www.data.gouv.fr/fr/datasets/r/e32f7675-913b-4e01-b8c8-0a29733e4407'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.ok(context.processingConfig.dataset.title.startsWith('Download file test'))
  })

  /*
  it('should download a file over sftp', async function () {
    this.timeout(10000)

    const processingConfig = {
      dataset: { title: 'Download file test sftp' },
      // cf https://test.rebex.net/
      url: 'sftp://test.rebex.net/pub/example/readme.txt',
      username: 'demo',
      password: 'password'
    }
    await fs.ensureDir('data/tmp')
    await downloadFile.run({
      pluginConfig: {},
      processingConfig,
      axios: axiosInstance,
      log,
      tmpDir: 'data/tmp',
      async patchConfig (patch) {
        console.log('received config patch', patch)
        Object.assign(processingConfig, patch)
      }
    })
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title.startsWith('Download file test sftp'))
    const datasetId = processingConfig.dataset.id
    assert.ok(datasetId.startsWith('transfer-file-test-sftp'))
  })

  it('should download a file over ftp', async function () {
    this.timeout(10000)

    const processingConfig = {
      dataset: { title: 'Download file test ftp' },
      // cf https://test.rebex.net/
      url: 'ftp://test.rebex.net/pub/example/readme.txt',
      username: 'demo',
      password: 'password'
    }
    await fs.ensureDir('data/tmp')
    await downloadFile.run({
      pluginConfig: {},
      processingConfig,
      axios: axiosInstance,
      log,
      tmpDir: 'data/tmp',
      async patchConfig (patch) {
        console.log('received config patch', patch)
        Object.assign(processingConfig, patch)
      }
    })
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title.startsWith('Download file test ftp'))
    const datasetId = processingConfig.dataset.id
    assert.ok(datasetId.startsWith('transfer-file-test-ftp'))
  })

  it('should load a line as bulk actions in rest dataset', async function () {
    this.timeout(10000)
    try {
      await axiosInstance.delete('api/v1/datasets/transfer-file-rest-test')
    } catch (err) {
      if (err.status !== 404) throw err
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    const dataset = (await axiosInstance.put('api/v1/datasets/transfer-file-rest-test', {
      isRest: true,
      title: 'transfer-file-rest-test',
      schema: [
        { key: 'Country', type: 'string' },
        { key: 'Place', type: 'string' },
        { key: 'Start_date', type: 'string' },
        { key: 'End_date', type: 'string' },
        { key: 'Level', type: 'string' }
      ]
    })).data
    await new Promise(resolve => setTimeout(resolve, 2000))
    const processingConfig = {
      dataset: { title: dataset.title, id: dataset.id },
      datasetMode: 'lines',
      url: 'https://koumoul.com/data-fair/api/v1/datasets/confinements-mondiaux/raw'
    }
    await fs.ensureDir('data/tmp')
    await downloadFile.run({
      pluginConfig: {},
      processingConfig,
      axios: axiosInstance,
      log,
      tmpDir: 'data/tmp',
      async patchConfig (patch) {
        console.log('received config patch', patch)
        Object.assign(processingConfig, patch)
      }
    })
    assert.equal(processingConfig.datasetMode, 'lines')
  })
    */
})

/*
describe('Hello world processing', () => {

  it('should run a task', async function () {
    const context = testUtils.context({
      pluginConfig: { pluginMessage: 'Hello' },
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'Hello world test' },
        message: 'world test !',
        delay: 1
      }
    // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)

    await helloWorldPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.dataset.title, 'Hello world test')
  })

  it('should use secrets', async function () {
    const processingConfig: ProcessingConfig = {
      datasetMode: 'create',
      dataset: { title: 'Hello world test' },
      message: 'world test !',
      delay: 1,
      secretField: 'Texte secret'
    }

    const prepareRes = await helloWorldPlugin.prepare({ processingConfig, secrets: { } })
    assert.ok(prepareRes.processingConfig)
    assert.equal(prepareRes.processingConfig.secretField, '********')

    assert.ok(prepareRes.secrets)
    assert.equal(prepareRes.secrets.secretField, 'Texte secret', 'the secret is not correctly returned by prepare function')

    const context = testUtils.context({
      pluginConfig: { pluginMessage: 'Hello' },
      processingConfig: prepareRes.processingConfig,
      secrets: prepareRes.secrets,
    // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)

    await helloWorldPlugin.run(context)
  })
})
*/
