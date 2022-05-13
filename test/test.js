process.env.NODE_ENV = 'test'
const config = require('config')
const axios = require('axios')
const chalk = require('chalk')
const dayjs = require('dayjs')
const assert = require('assert').strict
const fs = require('fs-extra')
const downloadFile = require('../')

const axiosInstance = axios.create()
axiosInstance.interceptors.request.use(cfg => {
  if (!/^https?:\/\//i.test(cfg.url)) {
    if (cfg.url.startsWith('/')) cfg.url = config.dataFairUrl + cfg.url
    else cfg.url = config.dataFairUrl + '/' + cfg.url
  }
  if (cfg.url.startsWith(config.dataFairUrl)) {
    cfg.headers['x-apiKey'] = config.dataFairAPIKey
  }
  return cfg
}, error => Promise.reject(error))
// customize axios errors for shorter stack traces when a request fails
axiosInstance.interceptors.response.use(response => response, error => {
  if (!error.response) return Promise.reject(error)
  delete error.response.request
  delete error.response.headers
  error.response.config = { method: error.response.config.method, url: error.response.config.url, data: error.response.config.data }
  if (error.response.config.data && error.response.config.data._writableState) delete error.response.config.data
  if (error.response.data && error.response.data._readableState) delete error.response.data
  return Promise.reject(error.response)
})

const log = {
  step: (msg) => console.log(chalk.blue.bold.underline(`[${dayjs().format('LTS')}] ${msg}`)),
  error: (msg, extra) => console.log(chalk.red.bold(`[${dayjs().format('LTS')}] ${msg}`), extra),
  warning: (msg, extra) => console.log(chalk.red(`[${dayjs().format('LTS')}] ${msg}`), extra),
  info: (msg, extra) => console.log(chalk.blue(`[${dayjs().format('LTS')}] ${msg}`), extra),
  debug: (msg, extra) => {
    // console.log(`[${dayjs().format('LTS')}] ${msg}`, extra)
  }
}

describe('Download file processing', () => {
  it('should expose a processing config schema for users', async () => {
    const schema = require('../processing-config-schema.json')
    assert.equal(schema.type, 'object')
  })

  it('should download a file over http', async function () {
    this.timeout(10000)

    const processingConfig = {
      dataset: { title: 'Download file test' },
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
    assert.equal(processingConfig.datasetMode, 'update')
    assert.ok(processingConfig.dataset.title.startsWith('Download file test'))
    const datasetId = processingConfig.dataset.id
    assert.ok(datasetId.startsWith('download-file-test'))
  })

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
    assert.ok(datasetId.startsWith('download-file-test-sftp'))
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
    assert.ok(datasetId.startsWith('download-file-test-ftp'))
  })

  it('should load a line as bulk actions in rest dataset', async function () {
    this.timeout(10000)
    try {
      await axiosInstance.delete('api/v1/datasets/download-file-rest-test')
    } catch (err) {
      if (err.status !== 404) throw err
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    const dataset = (await axiosInstance.put('api/v1/datasets/download-file-rest-test', {
      isRest: true,
      title: 'download-file-rest-test',
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
})
