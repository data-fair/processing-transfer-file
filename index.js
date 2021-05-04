function displayBytes (aSize) {
  aSize = Math.abs(parseInt(aSize, 10))
  if (aSize === 0) return '0 octets'
  const def = [[1, 'octets'], [1000, 'ko'], [1000 * 1000, 'Mo'], [1000 * 1000 * 1000, 'Go'], [1000 * 1000 * 1000 * 1000, 'To'], [1000 * 1000 * 1000 * 1000 * 1000, 'Po']]
  for (let i = 0; i < def.length; i++) {
    if (aSize < def[i][0]) return (aSize / def[i - 1][0]).toLocaleString() + ' ' + def[i - 1][1]
  }
}

exports.run = async ({ pluginConfig, processingConfig, processingId, tmpDir, axios, log, patchConfig }) => {
  const util = require('util')
  const pump = util.promisify(require('pump'))
  const fs = require('fs-extra')
  const path = require('path')
  const FormData = require('form-data')

  if (processingConfig.datasetMode === 'update') {
    await log.step('Vérification du jeu de données')
    const dataset = (await axios.get(`api/v1/datasets/${processingConfig.dataset.id}`)).data
    if (!dataset) throw new Error(`le jeu de données n'existe pas, id${processingConfig.dataset.id}`)
    await log.info(`le jeu de donnée existe, id="${dataset.id}", title="${dataset.title}"`)
  }

  await log.step('Téléchargement du fichier')
  const res = await axios.get(processingConfig.url, { responseType: 'stream' })
  const tmpFile = path.join(tmpDir, 'file')
  // creating empty file before streaming seems to fix some weird bugs with NFS
  await fs.ensureFile(tmpFile)
  await pump(res.data, fs.createWriteStream(tmpFile))
  // Try to prevent weird bug with NFS by forcing syncing file before reading it
  const fd = await fs.open(tmpFile, 'r')
  await fs.fsync(fd)
  await fs.close(fd)
  const filename = res.headers['content-disposition'] ? res.headers['content-disposition'].match(/filename="(.*)"/)[1] : decodeURIComponent(path.parse(processingConfig.url).base)
  await log.info(`le fichier a été téléchargé (${filename})`)

  await log.step('Chargement vers le jeu de données')
  const formData = new FormData()
  if (processingConfig.dataset.title) formData.append('title', processingConfig.dataset.title)
  formData.append('file', fs.createReadStream(tmpFile), { filename })
  formData.getLength = util.promisify(formData.getLength)
  const contentLength = await formData.getLength()
  await log.info(`chargement de (${displayBytes(contentLength)})`)
  const dataset = (await axios({
    method: 'post',
    url: processingConfig.dataset.id ? `api/v1/datasets/${processingConfig.dataset.id}` : 'api/v1/datasets',
    data: formData,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { ...formData.getHeaders(), 'content-length': contentLength }
  })).data
  await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  await log.info(`fichier chargé dans le jeu de donnée ${dataset.title} (${dataset.id})`)
}
