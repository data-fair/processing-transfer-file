import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { strict as assert } from 'node:assert'
import { mock, it, describe, beforeEach } from 'node:test'
import axios from 'axios'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import nock from 'nock'
import * as transferFilePlugin from '../../index.ts'
import * as transferLib from '../../lib/transfer.ts'

nock.disableNetConnect()

const csv = 'country\nfrance\nengland\n'

const sftpState: any = { getError: null, deleteError: null, getCalls: [], deleteCalls: [], ends: 0, connectOptions: null }
class MockSFTPClient {
  async connect (options: any) {
    sftpState.connectOptions = options
  }

  async get (remotePath: string, localPath: string) {
    sftpState.getCalls.push({ remotePath, localPath })
    if (sftpState.getError) throw sftpState.getError
    await fs.ensureFile(localPath)
    await fs.writeFile(localPath, csv)
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

const ftpState: any = { getError: null, deleteError: null, getCalls: [], deleteCalls: [], ends: 0, connectOptions: null }
class MockFTPClient extends EventEmitter {
  connect (options: any) {
    ftpState.connectOptions = options
    setTimeout(() => this.emit('ready'))
  }

  get (remotePath: string, cb: any) {
    ftpState.getCalls.push(remotePath)
    if (ftpState.getError) return cb(ftpState.getError)
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

const resetState = () => {
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
  const context: any = {
    processingConfig,
    secrets: overrides.secrets ?? {},
    tmpDir,
    axios: axios.create({ baseURL: 'http://datafair.test' }),
    log,
    patchConfig
  }
  return { context, tmpDir, log, patchConfig }
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
    assert.equal(log.warning.mock.calls[0].arguments[0], 'fichier non trouvé, exécution ignorée')
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
    await assert.rejects(() => transferFilePlugin.run(context), /protocole non supporté "webdav:"/)
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
      .post('/api/v1/datasets/ds1')
      .reply(200, function (uri: string, requestBody: any) {
        capturedBodies.push(requestBody)
        return { id: 'ds1', title: 'Existing dataset' }
      })
    const { context, log, patchConfig } = makeContext({
      processingConfig: { datasetMode: 'update', dataset: { id: 'ds1', title: 'Existing dataset' } }
    })
    await transferFilePlugin.run(context)
    assert.equal(log.step.mock.calls[0].arguments[0], 'Vérification du jeu de données')
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
    await assert.rejects(() => transferFilePlugin.run(context), /le jeu de données n'existe pas, idds1/)
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
    await assert.rejects(() => transferFilePlugin.run(context), /le jeu de données n'existe pas, idds1/)
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

  it('should load lines and log the errors', async () => {
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
    await transferFilePlugin.run(context)
    assert.equal(log.info.mock.calls.filter((call: any) => call.arguments[0] === 'lignes chargées: 1 ok, 0 sans modification, 2 en erreur').length, 1)
    assert.equal(log.error.mock.callCount(), 3)
    assert.equal(log.error.mock.calls[0].arguments[0], '2 erreurs rencontrées')
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
    assert.equal(sftpState.connectOptions.host, 'test.com')
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
    assert.equal(ftpState.connectOptions.host, 'test.com')
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
