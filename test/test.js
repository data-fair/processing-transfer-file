process.env.NODE_ENV = 'test'
const config = require('config')
const axios = require('axios')
const chalk = require('chalk')
const dayjs = require('dayjs')
const assert = require('assert').strict
const fs = require('fs-extra')
const downloadFile = require('../')

describe('Download file processing', () => {
  it('should expose a processing config schema for users', async () => {
    const schema = require('../processing-config-schema.json')
    assert.equal(schema.type, 'object')
  })

  it('should run a task', async function () {
    this.timeout(10000)

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
    const processingConfig = {
      dataset: { title: 'Download file test' },
      url: 'https://koumoul.com/s/data-fair/api/v1/datasets/confinements-mondiaux/raw'
    }
    await fs.ensureDir('data/tmp')
    await downloadFile.run({
      pluginConfig: {},
      processingConfig,
      axios: axiosInstance,
      log: {
        step: (msg) => console.log(chalk.blue.bold.underline(`[${dayjs().format('LTS')}] ${msg}`)),
        error: (msg, extra) => console.log(chalk.red.bold(`[${dayjs().format('LTS')}] ${msg}`), extra),
        warning: (msg, extra) => console.log(chalk.red(`[${dayjs().format('LTS')}] ${msg}`), extra),
        info: (msg, extra) => console.log(chalk.blue(`[${dayjs().format('LTS')}] ${msg}`), extra),
        debug: (msg, extra) => {
          // console.log(`[${dayjs().format('LTS')}] ${msg}`, extra)
        }
      },
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
})
