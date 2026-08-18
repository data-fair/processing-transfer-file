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
  const cleanup = async (context: any) => {
    // best-effort so shared instances don't accumulate leftover datasets
    try {
      await context.cleanup()
    } catch (err: any) {
      if (err.status !== 404 && err.status !== 403) throw err
    }
  }

  it('should download a file over http', async function () {
    nock('https://www.data.gouv.fr')
      .get('/fr/datasets/r/e32f7675-913b-4e01-b8c8-0a29733e4407')
      .reply(200, fs.readFileSync('test-it/resources/sample.csv', 'utf8'), { 'content-disposition': 'attachment; filename="sample.csv"' })
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
    await cleanup(context)
  })

  it('should download a file from a url with query parameters (signed url)', async function () {
    nock('https://test.com')
      .get('/signed.csv')
      .query(true)
      .reply(200, 'country\nfrance\nengland')
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test signed url' },
      url: 'https://test.com/signed.csv?sp=r&st=2026-08-11T09:23:33Z&se=2027-08-11T17:38:33Z&spr=https&sv=2026-02-06&sr=b&sig=mc%2BXko9gZWuTjWhJE6HiPEc4oGP7QO4OXBsFFgonz70%3D'
    }
    const context = testUtils.context({
      tmpDir: 'data/tmp', processingConfig
      // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    }, config, false)
    await transferFilePlugin.run(context)
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title!.startsWith('Download file test signed url'))
    await cleanup(context)
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
    await cleanup(context)
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
    await cleanup(context)
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
    await cleanup(context)
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
    await cleanup(context)
  })

  it('should load a line as bulk actions in rest dataset', async function () {
    const datasetId = 'transfer-file-rest-test-' + Date.now()
    // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
    const { axios } = testUtils.context({ }, config, false)

    try {
      await axios.delete('api/v1/datasets/' + datasetId)
    } catch (err: any) {
      if (err.status !== 404 && err.status !== 403) throw err
    }
    await new Promise(resolve => setTimeout(resolve, 1000))

    const dataset = (await axios.put('api/v1/datasets/' + datasetId, {
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

    try {
      await transferFilePlugin.run(context)
      assert.equal(processingConfig.datasetMode, 'lines')

      // the lines are indexed asynchronously, retry until they are searchable
      let total = 0
      for (let i = 0; i < 10; i++) {
        const { data } = await context.axios.get(`api/v1/datasets/${dataset.id}/lines`)
        total = data.total
        if (total === 2) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      assert.equal(total, 2)
    } finally {
      // best-effort cleanup so shared instances don't accumulate leftovers
      try {
        await context.axios.delete(`api/v1/datasets/${dataset.id}`)
      } catch {
        // ignore cleanup errors
      }
    }
  })
})
