import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '../types/processingConfig/index.ts'

import { formatBytes } from '@data-fair/lib-utils/format/bytes.js'
import { eventPromise } from '@data-fair/lib-utils/event-promise.js'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import FormData from 'form-data'
import path from 'node:path'
import fs from 'fs-extra'
import { exec as execCb } from 'node:child_process'

const exec = promisify(execCb)

class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileNotFoundError'
  }
}

const fetchHTTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string, axios: ProcessingContext['axios']) => {
  const password = secrets?.password ?? processingConfig.password
  const opts: any = { responseType: 'stream', maxRedirects: 4 }
  if (processingConfig.username && password) {
    opts.auth = { username: processingConfig.username, password }
  }
  let res
  try {
    res = await axios.get(processingConfig.url, opts)
  } catch (err: any) {
    if (err.response?.status === 404) throw new FileNotFoundError(`File not found: ${processingConfig.url}`)
    throw err
  }
  await pipeline(res.data, fs.createWriteStream(tmpFile))
  if (processingConfig.filename) return processingConfig.filename
  if (res.headers['content-disposition'] && res.headers['content-disposition'].includes('filename=')) {
    if (res.headers['content-disposition'].match(/filename=(.*);/)) return res.headers['content-disposition'].match(/filename=(.*);/)[1]
    if (res.headers['content-disposition'].match(/filename="(.*)"/)) return res.headers['content-disposition'].match(/filename="(.*)"/)[1]
    if (res.headers['content-disposition'].match(/filename=(.*)/)) return res.headers['content-disposition'].match(/filename=(.*)/)[1]
  }
  if (res.request && res.request.res && res.request.res.responseUrl) return decodeURIComponent(path.parse(res.request.res.responseUrl).base)
}

const fetchSFTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string) => {
  const url = new URL(processingConfig.url)
  const { default: SFTPClient } = await import('ssh2-sftp-client')
  const sftp = new SFTPClient()
  const password = secrets?.password ?? processingConfig.password
  const privateKey = secrets?.sshKey ?? processingConfig.sshKey
  try {
    await sftp.connect({
      host: url.hostname,
      port: Number(url.port),
      username: processingConfig.username,
      password,
      privateKey
    })
    await sftp.get(url.pathname, tmpFile)
  } catch (err: any) {
    if (err.message?.toLowerCase().includes('no such file') || err.code === 'ENOENT') {
      throw new FileNotFoundError(`File not found: ${url.pathname}`)
    }
    throw err
  }
  return processingConfig.filename || decodeURIComponent(path.basename(url.pathname))
}

const fetchFTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string) => {
  const url = new URL(processingConfig.url)
  const { default: FTPClient } = await import('ftp')
  const ftp = new FTPClient()
  const password = secrets?.password ?? processingConfig.password
  ftp.connect({ host: url.hostname, port: Number(url.port), user: processingConfig.username, password })
  await eventPromise(ftp, 'ready')
  let stream
  try {
    stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      ftp.get(url.pathname, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    })
  } catch (err: any) {
    if (err.message?.toLowerCase().includes('no such file') || err.message?.toLowerCase().includes('not found')) {
      throw new FileNotFoundError(`File not found: ${url.pathname}`)
    }
    throw err
  }
  await pipeline(stream, fs.createWriteStream(tmpFile))
  return processingConfig.filename || decodeURIComponent(path.basename(url.pathname))
}

const getContentLength = (formData: FormData) => {
  return new Promise<number>((resolve, reject) => {
    formData.getLength((err, length) => {
      if (err) reject(err)
      else resolve(length)
    })
  })
}

export const deleteRemoteFile = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets']) => {
  const url = new URL(processingConfig.url)
  const remotePath = url.pathname
  const password = secrets?.password ?? processingConfig.password

  if (url.protocol === 'sftp:') {
    const { default: SFTPClient } = await import('ssh2-sftp-client')
    const sftp = new SFTPClient()
    await sftp.connect({ host: url.hostname, port: Number(url.port), username: processingConfig.username, password })
    await sftp.delete(remotePath)
  } else if (url.protocol === 'ftp:' || url.protocol === 'ftps:') {
    const { default: FTPClient } = await import('ftp')
    const ftp = new FTPClient()
    ftp.connect({ host: url.hostname, port: Number(url.port), user: processingConfig.username, password })
    await eventPromise(ftp, 'ready')
    await new Promise<void>((resolve, reject) => {
      ftp.delete(remotePath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  const { processingConfig, secrets, tmpDir, axios, log, patchConfig } = context
  await fs.ensureDir(tmpDir)

  if (processingConfig.datasetMode === 'update') {
    await log.step('Vérification du jeu de données')
    const dataset = (await axios.get(`api/v1/datasets/${processingConfig.dataset.id}`)).data
    if (!dataset) throw new Error(`le jeu de données n'existe pas, id${processingConfig.dataset.id}`)
    await log.info(`le jeu de donnée existe, id="${dataset.id}", title="${dataset.title}"`)
  }

  await log.step('Téléchargement du fichier')
  const tmpFile = path.join(tmpDir, 'file')
  // creating empty file before streaming seems to fix some weird bugs with NFS
  await fs.ensureFile(tmpFile)

  const url = new URL(processingConfig.url)
  let filename = decodeURIComponent(path.parse(processingConfig.url).base)
  try {
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      filename = await fetchHTTP(processingConfig, secrets, tmpFile, axios) || filename
    } else if (url.protocol === 'sftp:') {
      await fetchSFTP(processingConfig, secrets, tmpFile)
    } else if (url.protocol === 'ftp:' || url.protocol === 'ftps:') {
      await fetchFTP(processingConfig, secrets, tmpFile)
    } else {
      throw new Error(`protocole non supporté "${url.protocol}"`)
    }
  } catch (err: any) {
    if (err instanceof FileNotFoundError && processingConfig.processAndDelete) {
      await log.warning(`fichier non trouvé, exécution ignorée`)
      return { deleteOnComplete: true }
    }
    throw err
  }

  // Try to prevent weird bug with NFS by forcing syncing file before reading it
  const fd = await fs.open(tmpFile, 'r')
  await fs.fsync(fd)
  await fs.close(fd)
  await log.info(`le fichier a été téléchargé (${filename})`)

  if (processingConfig.ignoreFirstLines) {
    await exec(`sed -i 1,${processingConfig.ignoreFirstLines}d ${tmpFile}`)
  }

  await log.step('Chargement vers le jeu de données')
  if (processingConfig.datasetMode === 'lines') {
    const formData = new FormData()
    formData.append('actions', fs.createReadStream(tmpFile), { filename })
    const contentLength = await getContentLength(formData)
    await log.info(`chargement de ${formatBytes(contentLength)} dans un jeu incrémental`)
    const result = (await axios({
      method: 'post',
      url: `api/v1/datasets/${processingConfig.dataset.id}/_bulk_lines?sep=${processingConfig.separator}`,
      data: formData,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { ...formData.getHeaders(), 'content-length': contentLength }
    })).data
    await log.info(`lignes chargées: ${result.nbOk.toLocaleString()} ok, ${result.nbNotModified.toLocaleString()} sans modification, ${result.nbErrors.toLocaleString()} en erreur`)
    if (result.nbErrors) {
      await log.error(`${result.nbErrors} erreurs rencontrées`)
      for (const error of result.errors) {
        await log.error(JSON.stringify(error))
      }
    }
  } else {
    const formData = new FormData()
    if (processingConfig.dataset && processingConfig.dataset.title) formData.append('title', processingConfig.dataset.title)
    formData.append('file', fs.createReadStream(tmpFile), { filename })
    if (processingConfig.encoding?.length) formData.append('file_encoding', processingConfig.encoding)
    const contentLength = await getContentLength(formData)
    await log.info(`chargement de ${formatBytes(contentLength)}`)
    const dataset = (await axios({
      method: 'post',
      url: (processingConfig.dataset && processingConfig.dataset.id) ? `api/v1/datasets/${processingConfig.dataset.id}` : 'api/v1/datasets',
      data: formData,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { ...formData.getHeaders(), 'content-length': contentLength }
    })).data
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
    await log.info(`fichier chargé dans le jeu de donnée ${dataset.title} (${dataset.id})`)
  }

  if (processingConfig.processAndDelete) {
    await log.info(`suppression du fichier source`)
    await deleteRemoteFile(processingConfig, secrets)
  }
}
