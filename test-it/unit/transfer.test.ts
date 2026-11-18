import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough, Readable } from 'node:stream'
import { strict as assert } from 'node:assert'
import { mock, it, describe, beforeEach } from 'node:test'
import axios from 'axios'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import nock from 'nock'
import * as transferFilePlugin from '../../index.ts'
import * as transferLib from '../../lib/transfer.ts'
import { stallOptions } from '../../lib/stall.ts'
import { finalizeOptions } from '../../lib/finalize.ts'

nock.disableNetConnect()

const csv = 'country\nfrance\nengland\n'

const sftpState: any = { stall: false, getError: null, deleteError: null, getCalls: [], deleteCalls: [], ends: 0, connectOptions: null }
class MockSFTPClient {
  async connect (options: any) {
    sftpState.connectOptions = options
  }

  async get (remotePath: string, dst: any) {
    sftpState.getCalls.push({ remotePath, dst })
    if (sftpState.getError) throw sftpState.getError
    // like ssh2-sftp-client: the transfer fails when its destination stream errors
    if (sftpState.stall) return new Promise((_resolve, reject) => dst.on('error', reject))
    dst.end(csv)
  }

  async delete (remotePath: string) {
    sftpState.deleteCalls.push(remotePath)
    if (sftpState.deleteError) throw sftpState.deleteError
  }

  async end () {
    sftpState.ends++
  }
}
mock.module('ssh2-sftp-client', { exports: { default: MockSFTPClient } })

const ftpState: any = { stall: null, getError: null, deleteError: null, getCalls: [], deleteCalls: [], ends: 0, connectOptions: null }
class MockFTPClient extends EventEmitter {
  connect (options: any) {
    ftpState.connectOptions = options
    setTimeout(() => this.emit('ready'))
  }

  get (remotePath: string, cb: any) {
    ftpState.getCalls.push(remotePath)
    if (ftpState.getError) return cb(ftpState.getError)
    if (ftpState.stall === 'get') return
    if (ftpState.stall === 'data') return cb(null, new PassThrough())
    cb(null, Readable.from([csv]))
  }

  delete (remotePath: string, cb: any) {
    ftpState.deleteCalls.push(remotePath)
    if (ftpState.deleteError) return cb(ftpState.deleteError)
    cb(null)
  }

  end () {
    ftpState.ends++
  }
}
mock.module('ftp', { exports: { default: MockFTPClient } })

// no DNS in unit tests: test.com resolves to a documentation address, other hosts are refused
const resolvedHosts: string[] = []
mock.module('@data-fair/lib-node/ssrf.js', {
  namedExports: {
    resolvePublicAddress: async (host: string) => {
      resolvedHosts.push(host)
      if (host === 'test.com') return '203.0.113.10'
      throw new Error(`connection to ${host} refused, it is not a public address`)
    }
  }
})

const resetState = () => {
  stallOptions.timeoutMs = 5 * 60 * 1000
  sftpState.stall = false
  ftpState.stall = null
  sftpState.getError = null
  sftpState.deleteError = null
  sftpState.getCalls = []
  sftpState.deleteCalls = []
  sftpState.ends = 0
  sftpState.connectOptions = null
  ftpState.getError = null
  ftpState.deleteError = null
  ftpState.getCalls = []
  ftpState.deleteCalls = []
  ftpState.ends = 0
  ftpState.connectOptions = null
}

const makeContext = (overrides: any = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-file-test-'))
  const processingConfig = {
    dataset: { title: 'Test dataset' },
    datasetMode: 'create',
    url: 'https://test.com/files/file.csv',
    ...overrides.processingConfig
  }
  const log = {
    step: mock.fn(async () => {}),
    info: mock.fn(async () => {}),
    warning: mock.fn(async () => {}),
    error: mock.fn(async () => {}),
    debug: mock.fn(async () => {})
  }
  const patchConfig = mock.fn(async () => {})
  // journal events replayed to the filter of ws.waitFor, like the data-fair worker would emit them
  const journal: any[] = overrides.journal ?? [{ type: 'finalize-end' }]
  const ws = {
    waitFor: mock.fn(async (_channel: string, filter: (e: any) => boolean, timeout: number) => {
      for (const event of journal) if (filter(event)) return event
      if (overrides.pendingJournal) return new Promise(() => {})
      throw new Error(`Timeout of ${timeout}ms exceeded`)
    })
  }
  const context: any = {
    processingConfig,
    secrets: overrides.secrets ?? {},
    tmpDir,
    axios: axios.create({ baseURL: 'http://datafair.test' }),
    ws,
    log,
    patchConfig
  }
  return { context, tmpDir, log, patchConfig, ws }
}

describe('run over http', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should download a file and create a dataset', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv, { 'content-disposition': 'attachment; filename="file.csv"' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        assert.equal(Number(this.req.headers['content-length']), requestBody.length)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context, patchConfig } = makeContext()
    await transferFilePlugin.run(context)
    assert.equal(patchConfig.mock.callCount(), 1)
    assert.deepEqual(patchConfig.mock.calls[0].arguments[0], { datasetMode: 'update', dataset: { id: 'ds1', title: 'Test dataset' } })
    assert.ok(capturedBodies[0].includes('filename="file.csv"'))
    assert.ok(capturedBodies[0].includes('name="file"'))
  })

  it('should use basic auth when a username and password are set', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, function (uri: string, requestBody: any) {
        assert.equal(this.req.headers['authorization'], 'Basic dXNlcjpwYXNz')
        return csv
      })
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context } = makeContext({
      processingConfig: { username: 'user', password: 'pass' }
    })
    await transferFilePlugin.run(context)
  })

  it('should use the password from secrets', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, function (uri: string, requestBody: any) {
        assert.equal(this.req.headers['authorization'], 'Basic dXNlcjpwYXNz')
        return csv
      })
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context } = makeContext({
      processingConfig: { username: 'user', password: '********' },
      secrets: { password: 'pass' }
    })
    await transferFilePlugin.run(context)
  })

  it('should not send auth when no password is set', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, function (uri: string, requestBody: any) {
        assert.equal(this.req.headers['authorization'], undefined)
        return csv
      })
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context } = makeContext({ processingConfig: { username: 'user' } })
    await transferFilePlugin.run(context)
  })

  it('should not send auth when no username is set', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, function (uri: string, requestBody: any) {
        assert.equal(this.req.headers['authorization'], undefined)
        return csv
      })
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context } = makeContext({ processingConfig: { password: 'pass' } })
    await transferFilePlugin.run(context)
  })

  it('should throw a FileNotFoundError on a 404 response', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(404, 'Not Found')
    const { context } = makeContext()
    await assert.rejects(() => transferFilePlugin.run(context), /File not found: https:\/\/test\.com\/files\/file\.csv/)
  })

  it('should rethrow other http errors', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(500, 'Server Error')
    const { context } = makeContext()
    await assert.rejects(() => transferFilePlugin.run(context), (err: any) => err.response?.status === 500)
  })

  it('should ignore the run when the file is not found and processAndDelete is set', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(404, 'Not Found')
    const { context, log } = makeContext({ processingConfig: { processAndDelete: true } })
    const result = await transferFilePlugin.run(context)
    assert.deepEqual(result, { deleteOnComplete: true })
    assert.equal(log.warning.mock.callCount(), 1)
    assert.equal(log.warning.mock.calls[0].arguments[0], 'source file not found, the run is skipped and removed from the history')
  })

  it('should parse the filename from a content-disposition with a trailing semicolon', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv, { 'content-disposition': 'attachment; filename=file.csv;' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="file.csv"'))
  })

  it('should parse the filename from a content-disposition with additional parameters', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv, { 'content-disposition': 'attachment; filename=report.csv; size=123; charset=binary' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="report.csv"'))
  })

  it('should parse a quoted filename from a content-disposition with additional parameters', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv, { 'content-disposition': 'attachment; filename="report.csv"; charset=utf-8' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="report.csv"'))
  })

  it('should parse the filename from a content-disposition without quotes', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv, { 'content-disposition': 'attachment; filename=file.csv' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="file.csv"'))
  })

  it('should use the filename from the config when set', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({ processingConfig: { filename: 'custom.csv' } })
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="custom.csv"'))
  })

  it('should derive the filename from the url when no content-disposition is provided', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="file.csv"'))
  })

  it('should derive the filename from the final url after a redirect', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(302, undefined, { location: 'https://cdn.com/files/final.csv' })
    nock('https://cdn.com')
      .get('/files/final.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="final.csv"'))
  })

  it('should throw an error for an unsupported protocol', async () => {
    const { context } = makeContext({ processingConfig: { url: 'webdav://test.com/file.csv' } })
    await assert.rejects(() => transferFilePlugin.run(context), /unsupported protocol "webdav:"/)
  })

  it('should check the dataset existence in update mode', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    nock('http://datafair.test')
      .get('/api/v1/datasets/ds1')
      .reply(200, { id: 'ds1', title: 'Existing dataset' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets/ds1').query(true)
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Existing dataset' }
      })
    const { context, log, patchConfig } = makeContext({
      processingConfig: { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await transferFilePlugin.run(context)
    assert.equal(log.step.mock.calls[0].arguments[0], 'Check the dataset')
    assert.equal(patchConfig.mock.callCount(), 1)
    assert.deepEqual(patchConfig.mock.calls[0].arguments[0], { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } })
    assert.ok(capturedBodies[0].includes('name="file"'))
  })

  it('should throw an error when the dataset does not exist in update mode', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    nock('http://datafair.test')
      .get('/api/v1/datasets/ds1')
      .reply(200, '')
    const { context } = makeContext({
      processingConfig: { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /dataset ds1 does not exist/)
  })

  it('should throw a clean error when the dataset is not found in update mode', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    nock('http://datafair.test')
      .get('/api/v1/datasets/ds1')
      .reply(404, { message: 'dataset not found' })
    const { context } = makeContext({
      processingConfig: { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /dataset ds1 does not exist/)
  })

  it('should rethrow other errors when checking the dataset in update mode', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    nock('http://datafair.test')
      .get('/api/v1/datasets/ds1')
      .reply(500, { message: 'server error' })
    const { context } = makeContext({
      processingConfig: { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await assert.rejects(() => transferFilePlugin.run(context), (err: any) => err.response?.status === 500)
  })

  it('should ignore the first lines of the file', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, 'first line\nsecond line\ncountry\nfrance\n')
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context, tmpDir } = makeContext({ processingConfig: { ignoreFirstLines: 2 } })
    await transferFilePlugin.run(context)
    assert.equal(await fs.readFile(path.join(tmpDir, 'file'), 'utf8'), 'country\nfrance\n')
  })

  it('should send the file encoding', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({ processingConfig: { encoding: 'utf-8' } })
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('name="file_encoding"'))
  })

  it('should log the rejected lines and fail the run', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    nock('http://datafair.test')
      .post('/api/v1/datasets/ds1/_bulk_lines')
      .query(true)
      .reply(200, { nbOk: 1, nbNotModified: 0, nbErrors: 2, errors: ['first error', 'second error'] })
    const { context, log } = makeContext({
      processingConfig: { datasetMode: 'lines', separator: ',', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /2 lines were rejected by data-fair, the source file is kept/)
    assert.equal(log.info.mock.calls.filter((call: any) => call.arguments[0] === 'lines loaded: 1 ok, 0 not modified, 2 in error').length, 1)
    assert.equal(log.error.mock.callCount(), 3)
    assert.equal(log.error.mock.calls[0].arguments[0], '2 lines in error')
  })

  it('should load lines without errors', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets/ds1/_bulk_lines')
      .query(true)
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { nbOk: 2, nbNotModified: 0, nbErrors: 0, errors: [] }
      })
    const { context, log } = makeContext({
      processingConfig: { datasetMode: 'lines', separator: ',', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await transferFilePlugin.run(context)
    assert.equal(log.error.mock.callCount(), 0)
    assert.ok(capturedBodies[0].includes('name="actions"'))
  })

  it('should not send a title when none is configured', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({ processingConfig: { dataset: { title: '' } } })
    await transferFilePlugin.run(context)
    assert.ok(!capturedBodies[0].includes('name="title"'))
  })
})

describe('run over sftp', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should download a file and create a dataset', async () => {
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({
      processingConfig: { url: 'sftp://test.com:2222/files/data.csv', username: 'user', password: 'pass' }
    })
    await transferFilePlugin.run(context)
    assert.equal(sftpState.getCalls.length, 1)
    assert.equal(sftpState.getCalls[0].remotePath, '/files/data.csv')
    assert.equal(sftpState.connectOptions.host, '203.0.113.10')
    assert.equal(sftpState.connectOptions.port, 2222)
    assert.equal(sftpState.connectOptions.username, 'user')
    assert.equal(sftpState.connectOptions.password, 'pass')
    assert.equal(sftpState.ends, 1)
    assert.ok(capturedBodies[0].includes('filename="data.csv"'))
  })

  it('should use the filename from the config', async () => {
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({
      processingConfig: { url: 'sftp://test.com/files/data.csv', filename: 'custom.csv' }
    })
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="custom.csv"'))
  })

  it('should throw a FileNotFoundError when the file does not exist', async () => {
    sftpState.getError = new Error('No such file or directory')
    const { context } = makeContext({
      processingConfig: { url: 'sftp://test.com/files/data.csv' }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /File not found: \/files\/data\.csv/)
    assert.equal(sftpState.ends, 1)
  })

  it('should throw a FileNotFoundError when sftp reports an ENOENT code', async () => {
    const err: any = new Error('something else')
    err.code = 'ENOENT'
    sftpState.getError = err
    const { context } = makeContext({
      processingConfig: { url: 'sftp://test.com/files/data.csv' }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /File not found: \/files\/data\.csv/)
    assert.equal(sftpState.ends, 1)
  })

  it('should rethrow other sftp errors', async () => {
    sftpState.getError = new Error('Connection refused')
    const { context } = makeContext({
      processingConfig: { url: 'sftp://test.com/files/data.csv' }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /Connection refused/)
    assert.equal(sftpState.ends, 1)
  })

  it('should delete the remote file after the import when processAndDelete is set', async () => {
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context } = makeContext({
      processingConfig: { url: 'sftp://test.com/files/data.csv', processAndDelete: true }
    })
    await transferFilePlugin.run(context)
    assert.deepEqual(sftpState.deleteCalls, ['/files/data.csv'])
    assert.equal(sftpState.ends, 2)
  })
})

describe('run over ftp', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should download a file and create a dataset', async () => {
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({
      processingConfig: { url: 'ftp://test.com:2121/files/data.csv', username: 'user', password: 'pass' }
    })
    await transferFilePlugin.run(context)
    assert.equal(ftpState.getCalls.length, 1)
    assert.equal(ftpState.getCalls[0], '/files/data.csv')
    assert.equal(ftpState.connectOptions.host, '203.0.113.10')
    assert.equal(ftpState.connectOptions.port, 2121)
    assert.equal(ftpState.connectOptions.user, 'user')
    assert.equal(ftpState.ends, 1)
    assert.ok(capturedBodies[0].includes('filename="data.csv"'))
  })

  it('should use the filename from the config', async () => {
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext({
      processingConfig: { url: 'ftp://test.com/files/data.csv', filename: 'custom.csv' }
    })
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="custom.csv"'))
  })

  it('should throw a FileNotFoundError when the file does not exist', async () => {
    ftpState.getError = new Error('550 No such file or directory')
    const { context } = makeContext({
      processingConfig: { url: 'ftp://test.com/files/data.csv' }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /File not found: \/files\/data\.csv/)
    assert.equal(ftpState.ends, 1)
  })

  it('should throw a FileNotFoundError when the ftp error mentions not found', async () => {
    ftpState.getError = new Error('550 file not found')
    const { context } = makeContext({
      processingConfig: { url: 'ftp://test.com/files/data.csv' }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /File not found: \/files\/data\.csv/)
    assert.equal(ftpState.ends, 1)
  })

  it('should rethrow other ftp errors', async () => {
    ftpState.getError = new Error('550 Permission denied')
    const { context } = makeContext({
      processingConfig: { url: 'ftp://test.com/files/data.csv' }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /Permission denied/)
    assert.equal(ftpState.ends, 1)
  })

  it('should delete the remote file after the import when processAndDelete is set', async () => {
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context } = makeContext({
      processingConfig: { url: 'ftp://test.com/files/data.csv', processAndDelete: true }
    })
    await transferFilePlugin.run(context)
    assert.deepEqual(ftpState.deleteCalls, ['/files/data.csv'])
    assert.equal(ftpState.ends, 2)
  })
})

describe('deleteRemoteFile', () => {
  beforeEach(() => {
    resetState()
  })

  it('should delete the remote file over sftp', async () => {
    await transferLib.deleteRemoteFile({ url: 'sftp://test.com/files/data.csv' } as any, {})
    assert.deepEqual(sftpState.deleteCalls, ['/files/data.csv'])
    assert.equal(sftpState.ends, 1)
  })

  it('should delete the remote file over ftp', async () => {
    await transferLib.deleteRemoteFile({ url: 'ftp://test.com/files/data.csv' } as any, {})
    assert.deepEqual(ftpState.deleteCalls, ['/files/data.csv'])
    assert.equal(ftpState.ends, 1)
  })

  it('should do nothing for other protocols', async () => {
    await transferLib.deleteRemoteFile({ url: 'https://test.com/files/data.csv' } as any, {})
    assert.equal(sftpState.deleteCalls.length, 0)
    assert.equal(ftpState.deleteCalls.length, 0)
  })
})

describe('ssrf protection', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should refuse to connect to a non public sftp host', async () => {
    const { context } = makeContext({ processingConfig: { url: 'sftp://localhost/files/data.csv' } })
    await assert.rejects(() => transferFilePlugin.run(context), /not a public address/)
    assert.equal(sftpState.connectOptions, null)
  })

  it('should refuse to connect to a non public ftp host', async () => {
    const { context } = makeContext({ processingConfig: { url: 'ftp://localhost/files/data.csv' } })
    await assert.rejects(() => transferFilePlugin.run(context), /not a public address/)
    assert.equal(ftpState.connectOptions, null)
  })

  it('should open the passive data connection on the checked address, not the one sent by the server', () => {
    const calls: any[] = []
    const ftp: any = { _pasvConnect (ip: string, port: number, cb: any) { calls.push({ ip, port, self: this }); cb() } }
    transferLib.pinPasvAddress(ftp, '203.0.113.10')
    ftp._pasvConnect('10.0.0.1', 2000, () => {})
    assert.equal(calls[0].ip, '203.0.113.10')
    assert.equal(calls[0].port, 2000)
    assert.equal(calls[0].self, ftp)
  })
})

describe('remote file names', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should keep only the base name of a decoded remote name', () => {
    assert.equal(transferLib.remoteFileName('..%2F..%2Fetc%2Fpasswd'), 'passwd')
    assert.equal(transferLib.remoteFileName('my%20file.csv'), 'my file.csv')
  })

  it('should strip the directory part of a content-disposition filename', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv, { 'content-disposition': 'attachment; filename="../../other/run.csv"' })
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context } = makeContext()
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('filename="run.csv"'))
  })
})

describe('data-fair upload', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should retry a rate limited upload with a rebuilt body', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, csv)
    const capturedBodies: any = []
    nock('http://datafair.test')
      .post('/api/v1/datasets/ds1').query(true)
      .reply(429, 'Too Many Requests', { 'retry-after': '0.001' })
      .post('/api/v1/datasets/ds1').query(true)
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Test dataset' }
      })
    const { context, log } = makeContext({ processingConfig: { datasetMode: 'update', dataset: { id: 'ds1' } } })
    nock('http://datafair.test').get('/api/v1/datasets/ds1').reply(200, { id: 'ds1', title: 'Test dataset' })
    await transferFilePlugin.run(context)
    assert.ok(capturedBodies[0].includes('france'))
    assert.equal(log.warning.mock.callCount(), 1)
  })

  it('should not upload anything when the run is stopped during the download', async () => {
    nock('https://test.com')
      .get('/files/file.csv')
      .reply(200, () => {
        transferFilePlugin.stop()
        return csv
      })
    const { context, patchConfig } = makeContext()
    await transferFilePlugin.run(context)
    assert.equal(patchConfig.mock.callCount(), 0)
    assert.ok(nock.isDone())
  })
})

describe('stalled downloads', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
    stallOptions.timeoutMs = 100
  })

  it('should fail an http download whose body stops coming after the headers', async () => {
    // nock only answers once the body starts: a real server is needed to send the headers alone
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/csv' })
      res.flushHeaders()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    nock.enableNetConnect('127.0.0.1')
    try {
      const { port } = server.address() as AddressInfo
      const { context, patchConfig } = makeContext({ processingConfig: { url: `http://127.0.0.1:${port}/file.csv` } })
      await assert.rejects(() => transferFilePlugin.run(context), /download stalled: no data received/)
      assert.equal(patchConfig.mock.callCount(), 0)
    } finally {
      nock.disableNetConnect()
      server.closeAllConnections()
      server.close()
    }
  })

  it('should fail a stalled sftp download and close the connection', async () => {
    sftpState.stall = true
    const { context, patchConfig } = makeContext({ processingConfig: { url: 'sftp://test.com/files/data.csv' } })
    await assert.rejects(() => transferFilePlugin.run(context), /download stalled: no data received/)
    assert.equal(sftpState.ends, 1)
    assert.equal(patchConfig.mock.callCount(), 0)
  })

  it('should fail an ftp download whose data connection never opens', async () => {
    ftpState.stall = 'get'
    const { context } = makeContext({ processingConfig: { url: 'ftp://test.com/files/data.csv' } })
    await assert.rejects(() => transferFilePlugin.run(context), /download stalled: no data received/)
    assert.equal(ftpState.ends, 1)
  })

  it('should fail an ftp download whose data stops coming', async () => {
    ftpState.stall = 'data'
    const { context } = makeContext({ processingConfig: { url: 'ftp://test.com/files/data.csv' } })
    await assert.rejects(() => transferFilePlugin.run(context), /download stalled: no data received/)
    assert.equal(ftpState.ends, 1)
  })

  it('should not fail a slow download that keeps receiving data', async () => {
    const body = new PassThrough()
    let sent = 0
    const interval = setInterval(() => {
      if (sent++ < 4) body.write(sent === 1 ? 'country\n' : 'france\n')
      else { clearInterval(interval); body.end() }
    }, 60)
    nock('https://test.com').get('/files/file.csv').reply(200, () => body)
    nock('http://datafair.test').post('/api/v1/datasets').reply(200, { id: 'ds1', title: 'Test dataset' })
    const { context, patchConfig } = makeContext()
    await transferFilePlugin.run(context)
    assert.equal(patchConfig.mock.callCount(), 1)
  })
})

describe('rejected lines', () => {
  beforeEach(() => {
    resetState()
    nock.cleanAll()
  })

  it('should keep the source file when lines are rejected', async () => {
    nock('http://datafair.test')
      .post('/api/v1/datasets/ds1/_bulk_lines')
      .query(true)
      .reply(200, { nbOk: 1, nbNotModified: 0, nbErrors: 1, errors: [{ line: 2, error: 'bad value' }] })
    const { context } = makeContext({
      processingConfig: { datasetMode: 'lines', separator: ',', dataset: { id: 'ds1' }, url: 'sftp://test.com/files/file.csv', processAndDelete: true }
    })
    await assert.rejects(() => transferFilePlugin.run(context), /1 lines were rejected/)
    assert.equal(sftpState.deleteCalls.length, 0)
  })

  it('should delete the source file when all the lines are loaded', async () => {
    nock('http://datafair.test')
      .post('/api/v1/datasets/ds1/_bulk_lines')
      .query(true)
      .reply(200, { nbOk: 2, nbNotModified: 0, nbErrors: 0, errors: [] })
    const { context } = makeContext({
      processingConfig: { datasetMode: 'lines', separator: ',', dataset: { id: 'ds1' }, url: 'sftp://test.com/files/file.csv', processAndDelete: true }
    })
    await transferFilePlugin.run(context)
    assert.deepEqual(sftpState.deleteCalls, ['/files/file.csv'])
  })
})

describe('schema compatibility of an update', () => {
  const updateConfig = { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } }

  // nock the dataset check and the upload, the query of the upload is captured
  const nockUpdate = () => {
    nock('https://test.com').get('/files/file.csv').reply(200, csv)
    const queries: any[] = []
    nock('http://datafair.test')
      .get('/api/v1/datasets/ds1')
      .reply(200, { id: 'ds1', title: 'Existing dataset' })
      .post('/api/v1/datasets/ds1')
      .query((query) => { queries.push(query); return true })
      .reply(200, { id: 'ds1', title: 'Existing dataset' })
    return queries
  }

  const breaking = { type: 'validation-error', data: 'The structure of the file contains breaking changes: the column "country" was removed', draft: true }
  const cancelled = { type: 'draft-cancelled', data: 'automatic cancellation', draft: true }

  beforeEach(() => {
    resetState()
    nock.cleanAll()
    finalizeOptions.timeoutMs = 60 * 60 * 1000
  })

  it('should ask data-fair to reject an incompatible file by default', async () => {
    const queries = nockUpdate()
    const { context, ws } = makeContext({ processingConfig: updateConfig })
    await transferFilePlugin.run(context)
    assert.equal(queries[0].draft, 'compatibleOrCancel')
    assert.equal(ws.waitFor.mock.calls[0].arguments[0], 'datasets/ds1/journal')
  })

  it('should fail the run when the file breaks the schema', async () => {
    nockUpdate()
    const { context, patchConfig } = makeContext({ processingConfig: updateConfig, journal: [{ type: 'finalize-start' }, breaking, cancelled] })
    await assert.rejects(() => transferFilePlugin.run(context), /column "country" was removed\. The new file was rejected and the dataset keeps its previous data/)
    // the dataset itself is unchanged in the config
    assert.equal(patchConfig.mock.callCount(), 1)
  })

  it('should fail the run when the finalized file is still a draft', async () => {
    nockUpdate()
    const { context } = makeContext({ processingConfig: updateConfig, journal: [{ type: 'finalize-end', draft: true }] })
    await assert.rejects(() => transferFilePlugin.run(context), /kept as a draft/)
  })

  it('should not delete the source file when the file is rejected', async () => {
    nockUpdate()
    const { context } = makeContext({
      processingConfig: { ...updateConfig, url: 'sftp://test.com/files/file.csv', processAndDelete: true },
      journal: [breaking, cancelled]
    })
    nock.cleanAll()
    nock('http://datafair.test')
      .get('/api/v1/datasets/ds1').reply(200, { id: 'ds1', title: 'Existing dataset' })
      .post('/api/v1/datasets/ds1').query(true).reply(200, { id: 'ds1', title: 'Existing dataset' })
    await assert.rejects(() => transferFilePlugin.run(context), /was rejected/)
    assert.equal(sftpState.deleteCalls.length, 0)
  })

  it('should publish an incompatible file when the schema update is forced', async () => {
    const queries = nockUpdate()
    const { context, log } = makeContext({
      processingConfig: { ...updateConfig, forceUpdate: true },
      journal: [breaking, { type: 'finalize-end' }]
    })
    await transferFilePlugin.run(context)
    assert.equal(queries[0].draft, 'always')
    assert.ok(log.warning.mock.calls.some((c: any) => /breaking changes.*The schema update is forced/.test(c.arguments[0])))
  })

  it('should fail the run when lines break the validation rules', async () => {
    nockUpdate()
    const { context } = makeContext({
      processingConfig: { ...updateConfig, forceUpdate: true },
      journal: [{ type: 'validation-error', data: '3 lines with a validation error', hasDiagnosticFile: true }]
    })
    await assert.rejects(() => transferFilePlugin.run(context), /does not respect the validation rules of the dataset: 3 lines/)
  })

  it('should fail the run when data-fair cannot process the file', async () => {
    nockUpdate()
    const { context, log } = makeContext({
      processingConfig: updateConfig,
      journal: [{ type: 'error-retry', data: 'parse error' }, { type: 'error', data: 'parse error' }]
    })
    await assert.rejects(() => transferFilePlugin.run(context), /data-fair could not process the file: parse error/)
    assert.ok(log.warning.mock.calls.some((c: any) => /will retry: parse error/.test(c.arguments[0])))
  })

  it('should fail the run with the error report when lines are rejected', async () => {
    nockUpdate()
    const { context } = makeContext({
      processingConfig: updateConfig,
      journal: [{ type: 'draft-cancelled', data: 'automatic cancellation: 3 lines with a validation error', hasDiagnosticFile: true }]
    })
    await assert.rejects(() => transferFilePlugin.run(context), /rejected and the dataset keeps its previous data: automatic cancellation: 3 lines with a validation error \(error report: api\/v1\/datasets\/ds1\/cancelled-draft-diagnostic\.csv\)/)
  })

  it('should fail the run when data-fair cancels the draft without a report', async () => {
    nockUpdate()
    const { context } = makeContext({ processingConfig: updateConfig, journal: [{ type: 'draft-cancelled', data: 'automatic cancellation' }] })
    await assert.rejects(() => transferFilePlugin.run(context), /keeps its previous data: automatic cancellation$/)
  })

  it('should only warn when data-fair takes longer than the wait timeout', async () => {
    nockUpdate()
    const { context, log } = makeContext({ processingConfig: updateConfig, journal: [] })
    await transferFilePlugin.run(context)
    assert.ok(log.warning.mock.calls.some((c: any) => /still processing the file/.test(c.arguments[0])))
  })

  it('should rethrow other websocket errors', async () => {
    nockUpdate()
    const { context, ws } = makeContext({ processingConfig: updateConfig })
    ws.waitFor.mock.mockImplementation(async () => { throw new Error('socket hang up') })
    await assert.rejects(() => transferFilePlugin.run(context), /socket hang up/)
  })

  it('should stop waiting when the run is stopped', async () => {
    nockUpdate()
    const { context, log } = makeContext({ processingConfig: updateConfig, pendingJournal: true, journal: [] })
    log.step.mock.mockImplementation(async (name: string) => {
      if (name === 'Wait for data-fair to process the file') setTimeout(() => transferFilePlugin.stop())
    })
    await transferFilePlugin.run(context)
    assert.ok(log.warning.mock.calls.some((c: any) => /run stopped while data-fair was processing/.test(c.arguments[0])))
  })

  it('should wait for the processing of a new dataset too', async () => {
    nock('https://test.com').get('/files/file.csv').reply(200, csv)
    nock('http://datafair.test').post('/api/v1/datasets').reply(200, { id: 'new1', title: 'Test dataset' })
    const { context, ws } = makeContext({ journal: [{ type: 'error', data: 'unsupported file' }] })
    await assert.rejects(() => transferFilePlugin.run(context), /could not process the file: unsupported file/)
    assert.equal(ws.waitFor.mock.calls[0].arguments[0], 'datasets/new1/journal')
  })
})
