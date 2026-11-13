import type { ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

import { formatBytes } from '@data-fair/lib-utils/format/bytes.js'
import { eventPromise } from '@data-fair/lib-utils/event-promise.js'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import FormData from 'form-data'
import path from 'node:path'
import fs from 'fs-extra'
import { execFile as execFileCb } from 'node:child_process'
import { dfRetry, errorStatus } from './retry.ts'

const execFile = promisify(execFileCb)

let shouldBeStopped = false
export const stop = async () => { shouldBeStopped = true }

// a name read from the url or sent by the remote server is only kept as a plain
// file name (no directory part, no traversal once percent-decoded)
export const remoteFileName = (name: string) => path.basename(decodeURIComponent(name))

class FileNotFoundError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'FileNotFoundError'
  }
}

const fetchHTTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string, axios: ProcessingContext['axios']) => {
  const password = secrets?.password ?? processingConfig.password
  // remote host: follow its redirects, and give up on a server that stops answering
  const opts: any = { responseType: 'stream', maxRedirects: 4, timeout: 60000 }
  if (processingConfig.username && password) {
    opts.auth = { username: processingConfig.username, password }
  }
  let res
  try {
    res = await axios.get(processingConfig.url, opts)
  } catch (err: any) {
    if (errorStatus(err) === 404) throw new FileNotFoundError(`File not found: ${processingConfig.url}`)
    throw err
  }
  await pipeline(res.data, fs.createWriteStream(tmpFile))
  if (processingConfig.filename) return processingConfig.filename
  if (res.headers['content-disposition'] && res.headers['content-disposition'].includes('filename=')) {
    const contentDisposition = res.headers['content-disposition']
    const quoted = contentDisposition.match(/filename="([^"]*)"/)
    if (quoted) return path.basename(quoted[1])
    const plain = contentDisposition.match(/filename=([^;]*)/)
    if (plain) return path.basename(plain[1].trim())
  }
  if (res.request && res.request.res && res.request.res.responseUrl) {
    const responseUrl = new URL(res.request.res.responseUrl)
    return remoteFileName(path.parse(responseUrl.pathname).base)
  }
}

// open an SFTP connection. Download and deletion each open their own: the
// upload to data-fair happens in between and could outlive the session.
// Whoever opens one is responsible for closing it (see the finally blocks).
const connectSFTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets']) => {
  const url = new URL(processingConfig.url)
  const { default: SFTPClient } = await import('ssh2-sftp-client')
  const { resolvePublicAddress } = await import('@data-fair/lib-node/ssrf.js')
  const sftp = new SFTPClient()
  await sftp.connect({
    // the host is chosen by the user: connect to its checked public address (SSRF protection)
    host: await resolvePublicAddress(url.hostname),
    port: url.port ? Number(url.port) : undefined,
    username: processingConfig.username,
    password: secrets?.password ?? processingConfig.password,
    privateKey: secrets?.sshKey ?? processingConfig.sshKey
  })
  return sftp
}

const fetchSFTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string) => {
  const url = new URL(processingConfig.url)
  const sftp = await connectSFTP(processingConfig, secrets)
  try {
    await sftp.get(url.pathname, tmpFile)
  } catch (err: any) {
    if (err.message?.toLowerCase().includes('no such file') || err.code === 'ENOENT') {
      throw new FileNotFoundError(`File not found: ${url.pathname}`)
    }
    throw err
  } finally {
    await sftp.end()
  }
  return processingConfig.filename || remoteFileName(path.basename(url.pathname))
}

// in passive mode the server chooses the address of the data connection (PASV response),
// ignore it and always connect to the checked address of the control connection
export const pinPasvAddress = (ftp: any, host: string) => {
  const pasvConnect = ftp._pasvConnect
  ftp._pasvConnect = function (_ip: string, port: number, cb: (err?: Error, sock?: any) => void) {
    return pasvConnect.call(this, host, port, cb)
  }
}

// same as connectSFTP for the plain FTP protocols
const connectFTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets']) => {
  const url = new URL(processingConfig.url)
  const { default: FTPClient } = await import('ftp')
  const { resolvePublicAddress } = await import('@data-fair/lib-node/ssrf.js')
  // the host is chosen by the user: connect to its checked public address (SSRF protection)
  const host = await resolvePublicAddress(url.hostname)
  const ftp = new FTPClient()
  pinPasvAddress(ftp, host)
  ftp.connect({ host, port: url.port ? Number(url.port) : undefined, user: processingConfig.username, password: secrets?.password ?? processingConfig.password })
  await eventPromise(ftp, 'ready')
  return ftp
}

const fetchFTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string) => {
  const url = new URL(processingConfig.url)
  const ftp = await connectFTP(processingConfig, secrets)
  try {
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      ftp.get(url.pathname, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    })
    await pipeline(stream, fs.createWriteStream(tmpFile))
  } catch (err: any) {
    if (err.message?.toLowerCase().includes('no such file') || err.message?.toLowerCase().includes('not found')) {
      throw new FileNotFoundError(`File not found: ${url.pathname}`)
    }
    throw err
  } finally {
    ftp.end()
  }
  return processingConfig.filename || remoteFileName(path.basename(url.pathname))
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

  if (url.protocol === 'sftp:') {
    const sftp = await connectSFTP(processingConfig, secrets)
    try {
      await sftp.delete(remotePath)
    } finally {
      await sftp.end()
    }
  } else if (url.protocol === 'ftp:' || url.protocol === 'ftps:') {
    const ftp = await connectFTP(processingConfig, secrets)
    try {
      await new Promise<void>((resolve, reject) => {
        ftp.delete(remotePath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    } finally {
      ftp.end()
    }
  }
}

export const run = async (context: ProcessingContext<ProcessingConfig>) => {
  const { processingConfig, secrets, tmpDir, axios, log, patchConfig } = context
  shouldBeStopped = false
  await fs.ensureDir(tmpDir)

  if (processingConfig.datasetMode === 'update') {
    await log.step('Vérification du jeu de données')
    let dataset: any
    try {
      dataset = (await axios.get(`api/v1/datasets/${processingConfig.dataset.id}`)).data
    } catch (err: any) {
      if (errorStatus(err) === 404) throw new Error(`le jeu de données n'existe pas, id${processingConfig.dataset.id}`)
      throw err
    }
    if (!dataset) throw new Error(`le jeu de données n'existe pas, id${processingConfig.dataset.id}`)
    await log.info(`le jeu de donnée existe, id="${dataset.id}", title="${dataset.title}"`)
  }

  await log.step('Téléchargement du fichier')
  const tmpFile = path.join(tmpDir, 'file')
  // creating empty file before streaming seems to fix some weird bugs with NFS
  await fs.ensureFile(tmpFile)

  const url = new URL(processingConfig.url)
  let filename = remoteFileName(path.parse(url.pathname).base)
  try {
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      filename = await fetchHTTP(processingConfig, secrets, tmpFile, axios) || filename
    } else if (url.protocol === 'sftp:') {
      filename = await fetchSFTP(processingConfig, secrets, tmpFile)
    } else if (url.protocol === 'ftp:' || url.protocol === 'ftps:') {
      filename = await fetchFTP(processingConfig, secrets, tmpFile)
    } else {
      throw new Error(`protocole non supporté "${url.protocol}"`)
    }
  } catch (err: any) {
    if (err instanceof FileNotFoundError && processingConfig.processAndDelete) {
      await log.warning('fichier non trouvé, exécution ignorée')
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
    await execFile('sed', ['-i', `1,${Number(processingConfig.ignoreFirstLines)}d`, tmpFile])
  }

  // a stopped run must not publish a partial file
  if (shouldBeStopped) {
    await log.warning('interrompu avant le chargement, le jeu de données n\'est pas modifié')
    return
  }

  await log.step('Chargement vers le jeu de données')
  if (processingConfig.datasetMode === 'lines') {
    // the form body streams the file: it is rebuilt on each attempt
    const buildForm = () => {
      const formData = new FormData()
      formData.append('actions', fs.createReadStream(tmpFile), { filename })
      return formData
    }
    await log.info(`chargement de ${formatBytes((await fs.stat(tmpFile)).size)} dans un jeu incrémental`)
    const bulkUrl = `api/v1/datasets/${processingConfig.dataset.id}/_bulk_lines?sep=${processingConfig.separator}`
    // lines without an _id would be inserted twice if a gateway error hid a bulk that went through
    const result = (await dfRetry(async () => {
      const formData = buildForm()
      return axios({
        method: 'post',
        url: bulkUrl,
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': await getContentLength(formData) }
      })
    }, log, { label: 'POST _bulk_lines', creates: true })).data
    await log.info(`lignes chargées: ${result.nbOk.toLocaleString()} ok, ${result.nbNotModified.toLocaleString()} sans modification, ${result.nbErrors.toLocaleString()} en erreur`)
    if (result.nbErrors) {
      await log.error(`${result.nbErrors} erreurs rencontrées`)
      for (const error of result.errors) {
        await log.error(JSON.stringify(error))
      }
    }
  } else {
    const buildForm = () => {
      const formData = new FormData()
      if (processingConfig.dataset && processingConfig.dataset.title) formData.append('title', processingConfig.dataset.title)
      formData.append('file', fs.createReadStream(tmpFile), { filename })
      if (processingConfig.encoding?.length) formData.append('file_encoding', processingConfig.encoding)
      return formData
    }
    await log.info(`chargement de ${formatBytes((await fs.stat(tmpFile)).size)}`)
    const datasetId = processingConfig.dataset && processingConfig.dataset.id
    const uploadUrl = datasetId ? `api/v1/datasets/${datasetId}` : 'api/v1/datasets'
    const dataset = (await dfRetry(async () => {
      const formData = buildForm()
      return axios({
        method: 'post',
        url: uploadUrl,
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': await getContentLength(formData) }
      })
    }, log, { label: `POST ${uploadUrl}`, creates: !datasetId })).data
    await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
    await log.info(`fichier chargé dans le jeu de donnée ${dataset.title} (${dataset.id})`)
  }

  if (processingConfig.processAndDelete) {
    await log.info('suppression du fichier source')
    await deleteRemoteFile(processingConfig, secrets)
  }
}
