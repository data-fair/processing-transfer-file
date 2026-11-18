import type { ProcessingConfig } from '../types/processingConfig/index.ts'
import fs from 'fs-extra'
import config from 'config'
import { strict as assert } from 'node:assert'
import { it, describe, beforeEach, after } from 'node:test'
import nock from 'nock'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as transferFilePlugin from '../index.ts'

// The downloads are real (local sftp server of test-deps, public rebex test server for ftp
// and sftp), data-fair is not: its API is answered by nock on config.dataFairUrl and its
// websocket by a fake client replaying journal events.
const dataFair = config.get<string>('dataFairUrl')
const sshKey = fs.readFileSync('test-it/resources/user_keys/id_rsa', 'utf8')
const tmpDir = 'data/tmp'

const fakeWs = (journal: any[] = [{ type: 'finalize-end' }]) => ({
  waitFor: async (_channel: string, filter: (e: any) => boolean) => {
    for (const event of journal) if (filter(event)) return event
    return new Promise(() => {})
  },
  close: () => {}
})

const makeContext = (processingConfig: ProcessingConfig, extra: any = {}, journal?: any[]) => {
  // @ts-ignore ProcessingTestConfig should be optional in lib-processing-dev
  const context = testUtils.context({ tmpDir, processingConfig, ...extra }, config, false)
  context.ws.close()
  context.ws = fakeWs(journal) as any
  return context
}

// nock the creation of a dataset and capture the uploaded multipart body
const nockCreate = (id = 'ds1') => {
  const uploads: string[] = []
  nock(dataFair)
    .post('/api/v1/datasets')
    .reply(200, (_uri: string, body: any) => {
      uploads.push(body)
      return { id, title: 'Download file test' }
    })
  return uploads
}

describe('Download file processing', () => {
  beforeEach(() => {
    nock.cleanAll()
  })
  after(() => {
    nock.cleanAll()
    fs.removeSync(tmpDir)
  })

  it('should download a file over http', async function () {
    nock('https://www.data.gouv.fr')
      .get('/fr/datasets/r/e32f7675-913b-4e01-b8c8-0a29733e4407')
      .reply(200, fs.readFileSync('test-it/resources/sample.csv', 'utf8'), { 'content-disposition': 'attachment; filename="sample.csv"' })
    const uploads = nockCreate()
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test' },
      url: 'https://www.data.gouv.fr/fr/datasets/r/e32f7675-913b-4e01-b8c8-0a29733e4407'
    }
    await transferFilePlugin.run(makeContext(processingConfig))
    assert.equal(processingConfig.datasetMode, 'update')
    assert.equal(processingConfig.dataset.id, 'ds1')
    assert.ok(uploads[0].includes('filename="sample.csv"'))
    assert.ok(uploads[0].includes(fs.readFileSync('test-it/resources/sample.csv', 'utf8')))
  })

  it('should download a file from a url with query parameters (signed url)', async function () {
    nock('https://test.com')
      .get('/signed.csv')
      .query(true)
      .reply(200, 'country\nfrance\nengland')
    const uploads = nockCreate()
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test signed url' },
      url: 'https://test.com/signed.csv?sp=r&st=2026-08-11T09:23:33Z&se=2027-08-11T17:38:33Z&spr=https&sv=2026-02-06&sr=b&sig=mc%2BXko9gZWuTjWhJE6HiPEc4oGP7QO4OXBsFFgonz70%3D'
    }
    await transferFilePlugin.run(makeContext(processingConfig))
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(uploads[0].includes('filename="signed.csv"'))
    assert.ok(uploads[0].includes('country\nfrance\nengland'))
  })

  it('should download a file over sftp', async function () {
    const uploads = nockCreate()
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test sftp' },
      // cf https://test.rebex.net/
      url: 'sftp://test.rebex.net/pub/example/readme.txt',
      username: 'demo',
      password: 'password'
    }
    await transferFilePlugin.run(makeContext(processingConfig))
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(uploads[0].includes('filename="readme.txt"'))
  })

  it('should download a file over sftp with private key auth', async function () {
    const uploads = nockCreate()
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test sftp with key' },
      url: 'sftp://localhost:31022/landing-zone/test.txt',
      username: 'test3',
      sshKey
    }
    await transferFilePlugin.run(makeContext(processingConfig))
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(uploads[0].includes(fs.readFileSync('test-it/resources/test.txt', 'utf8')))
  })

  it('should download a file over sftp with private key auth in secret', async function () {
    const uploads = nockCreate()
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test sftp with key' },
      url: 'sftp://localhost:31022/landing-zone/test.txt',
      username: 'test3',
      sshKey: '***'
    }
    await transferFilePlugin.run(makeContext(processingConfig, { secrets: { sshKey } }))
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(uploads[0].includes(fs.readFileSync('test-it/resources/test.txt', 'utf8')))
  })

  it('should download a file over ftp', async function () {
    const uploads = nockCreate()
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'Download file test ftp' },
      // cf https://test.rebex.net/
      url: 'ftp://test.rebex.net/pub/example/readme.txt',
      username: 'demo',
      password: 'password'
    }
    await transferFilePlugin.run(makeContext(processingConfig))
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(uploads[0].includes('filename="readme.txt"'))
  })

  it('should update an existing dataset and reject a file that breaks its schema', async function () {
    nock('https://test.com').get('/error-page').reply(200, '<html><body>Service unavailable</body></html>', { 'content-type': 'text/html' })
    const queries: any[] = []
    nock(dataFair)
      .get('/api/v1/datasets/ds1').reply(200, { id: 'ds1', title: 'Existing dataset' })
      .post('/api/v1/datasets/ds1').query((q) => { queries.push(q); return true })
      .reply(200, { id: 'ds1', title: 'Existing dataset' })
    const processingConfig: ProcessingConfig = {
      datasetMode: 'update',
      dataset: { id: 'ds1', title: 'Existing dataset' },
      url: 'https://test.com/error-page',
      filename: 'data.csv'
    }
    const journal = [
      { type: 'validation-error', data: 'The structure of the file contains breaking changes: the column "country" was removed' },
      { type: 'draft-cancelled', data: 'automatic cancellation' }
    ]
    await assert.rejects(() => transferFilePlugin.run(makeContext(processingConfig, {}, journal)), /The new file was rejected and the dataset keeps its previous data/)
    assert.equal(queries[0].draft, 'compatibleOrCancel')
  })

  it('should load a line as bulk actions in rest dataset', async function () {
    nock('https://test.com')
      .get('/lines.csv')
      .reply(200, 'country\nfrance\nengland')
    const bulks: string[] = []
    nock(dataFair)
      .post('/api/v1/datasets/rest1/_bulk_lines')
      .query({ sep: ',' })
      .reply(200, (_uri: string, body: any) => {
        bulks.push(body)
        return { nbOk: 2, nbNotModified: 0, nbErrors: 0, errors: [] }
      })
    const processingConfig: ProcessingConfig = {
      dataset: { title: 'transfer-file-rest-test', id: 'rest1' },
      datasetMode: 'lines',
      separator: ',',
      url: 'https://test.com/lines.csv'
    }
    await transferFilePlugin.run(makeContext(processingConfig))
    assert.equal(processingConfig.datasetMode, 'lines')
    assert.ok(bulks[0].includes('name="actions"'))
    assert.ok(bulks[0].includes('country\nfrance\nengland'))
  })
})
