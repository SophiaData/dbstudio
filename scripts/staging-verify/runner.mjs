import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { VerifyError, requireCheck, privateRead, safeWrite, httpsRequest, acquireTokens } from './security.mjs'

const DB_NAMES = ['postgres', 'mysql', 'redis', 'kafka']
const DIALECTS = { postgres: 'postgresql', mysql: 'mysql', redis: 'redis', kafka: 'kafka' }
const digest = (value) => createHash('sha256').update(value).digest('hex')
const pathFor = (id, action = '') => `/connections/${encodeURIComponent(id)}${action ? `/${action}` : ''}`
const artifactPath = (id) => `/artifacts/${encodeURIComponent(id)}`
const isId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)

export function failureReport(phase = 'prepare', code = 'VERIFIER_FAILED') {
  return { schemaVersion: 1, phase, status: 'failed', environmentPassed: false,
    checks: [{ name: 'runner', code, status: 0, durationMs: 0, result: 'failed' }] }
}

export async function runVerification(config, options = {}) {
  const phase = options.phase ?? 'prepare'
  const synthetic = options.synthetic === true
  const transport = options.transport ?? httpsRequest
  const checks = []
  let state
  let tokens
  let stateFile
  let lastStatus = 0
  const step = async (name, action) => {
    const started = Date.now()
    lastStatus = 0
    try {
      const value = await action()
      checks.push({ name, code: 'OK', status: lastStatus, durationMs: Math.max(0, Date.now() - started), result: 'passed' })
      return { passed: true, value }
    } catch (error) {
      checks.push({ name, code: error instanceof VerifyError ? error.code : 'CHECK_FAILED',
        status: error instanceof VerifyError ? error.status : 0, durationMs: Math.max(0, Date.now() - started), result: 'failed' })
      return { passed: false }
    }
  }
  const skip = (name, code = 'OPTIONAL_NOT_CONFIGURED') => checks.push({ name, code, status: 0, durationMs: 0, result: 'skipped' })
  const save = () => safeWrite(stateFile, state, { privateFile: true })
  const request = async (owner, path, method = 'GET', body, headers, tokenOverride) => {
    requireCheck(path.startsWith('/') && !path.startsWith('//') && !/[?#\\]/.test(path), 'REQUEST_PATH_INVALID')
    const result = await transport({ url: new URL(path, config.endpoint).href, method, body, headers,
      token: tokenOverride === undefined ? tokens[owner] : tokenOverride, ca: config.ca, timeoutMs: config.timeoutMs })
    lastStatus = result.status
    return result
  }
  const expect = (result, status = 200, success = true) => {
    requireCheck(result.status === status, 'HTTP_STATUS_MISMATCH', result.status)
    if (success) requireCheck(result.json?.ok === true, 'API_RESULT_INVALID', result.status)
    else requireCheck(result.json?.ok === false, 'API_REJECTION_INVALID', result.status)
    return result.json?.value
  }
  const rpc = async (owner, method, args) => expect(await request(owner, '/rpc', 'POST', { id: randomUUID(), method, args }))
  const list = async (owner) => {
    const value = expect(await request(owner, '/connections'))
    requireCheck(Array.isArray(value) && value.every((item) => isId(item?.id)), 'CONNECTION_LIST_INVALID')
    return value
  }
  const ownConnection = async (resource) => {
    const item = (await list(resource.owner)).find((entry) => entry.id === resource.id)
    requireCheck(item && resource.names.includes(item.name), 'RESOURCE_OWNERSHIP_MISMATCH')
    return item
  }
  const removeConnection = async (resource) => {
    const item = (await list(resource.owner)).find((entry) => entry.id === resource.id)
    if (item) {
      requireCheck(resource.names.includes(item.name), 'RESOURCE_OWNERSHIP_MISMATCH')
      expect(await request(resource.owner, pathFor(resource.id), 'DELETE'))
    }
    requireCheck(!(await list(resource.owner)).some((entry) => entry.id === resource.id), 'CONNECTION_DELETE_FAILED')
    state.connections = state.connections.filter((entry) => entry !== resource)
    save()
  }
  const canary = async (resource) => {
    const nodeId = `connection:${resource.id}`
    const children = await rpc(resource.owner, 'listChildren', [nodeId])
    requireCheck(Array.isArray(children), 'METADATA_RESULT_INVALID')
    if (resource.dbKey === 'postgres' || resource.dbKey === 'mysql') {
      const query = await rpc(resource.owner, 'runQuery', [nodeId, 'SELECT 1 AS staging_probe'])
      try {
        requireCheck(Array.isArray(query?.rows) && query.rows.length === 1 &&
          (Array.isArray(query.rows[0]) ? Number(query.rows[0][0]) === 1 : Number(query.rows[0]?.staging_probe) === 1), 'QUERY_CANARY_FAILED')
      } finally {
        if (typeof query?.cursorId === 'string') await rpc(resource.owner, 'closeCursor', [query.cursorId])
      }
    }
  }
  const finish = () => {
    const failed = checks.some((entry) => entry.result === 'failed')
    if (state) {
      state.checks.push(...checks)
      if (!failed) {
        if (phase === 'prepare') state.prepared = true
        if (phase === 'cleanup') state.cleaned = true
      }
      save()
    }
    const allChecks = state ? state.checks : checks
    const passed = !failed && !allChecks.some((entry) => entry.result === 'failed')
    const transitionsPassed = (!config.restart?.required || state?.transitions?.restart === true) &&
      (!config.rollback?.required || state?.transitions?.rollback === true) &&
      (!config.driverFault?.required || state?.transitions?.['driver-fault'] === true)
    return { schemaVersion: 1, phase, status: failed ? 'failed' : 'passed',
      environmentPassed: !synthetic && passed && state?.prepared === true && transitionsPassed,
      checks: allChecks }
  }

  const preflight = await step('configuration', async () => {
    requireCheck(['prepare', 'resume', 'rollback', 'recover', 'cleanup'].includes(phase), 'PHASE_INVALID')
    requireCheck(typeof config.endpoint === 'string', 'ENDPOINT_REQUIRED')
    requireCheck(config.stateFile || options.stateFile, 'STATE_FILE_REQUIRED')
    stateFile = resolve(options.stateFile ?? config.stateFile)
    requireCheck(!config.inputFiles?.has(stateFile), 'OUTPUT_INPUT_COLLISION')
    if (phase === 'prepare') {
      let configured = 0
      for (const name of DB_NAMES) {
        const db = config.databases?.[name]
        if (db?.config) {
          requireCheck(db.config.dialectId === DIALECTS[name] && db.config.options && typeof db.config.options === 'object', 'DATABASE_CONFIG_INVALID')
          configured += 1
        } else requireCheck(db?.required === false, 'REQUIRED_DATABASE_MISSING')
        requireCheck(!db?.negativeRequired || db.negativeConfig?.config, 'REQUIRED_NEGATIVE_CONFIG_MISSING')
      }
      requireCheck(configured > 0, 'DATABASE_CONFIG_REQUIRED')
    }
  })
  if (!preflight.passed) return finish()
  checks.push({ name: 'mode', code: synthetic ? 'SYNTHETIC_ONLY' : 'REMOTE_HTTPS', status: 0, durationMs: 0, result: 'passed' })
  const identity = await step('authentication.tokens', async () => {
    const acquired = await acquireTokens(config, transport)
    tokens = acquired.tokens
    return digest(JSON.stringify([config.endpoint, acquired.subs.a, acquired.subs.b]))
  })
  if (!identity.passed) return finish()
  const stateReady = await step('private-state', async () => {
    if (phase === 'prepare') {
      const newState = { schemaVersion: 1, nonce: randomUUID(), synthetic, binding: identity.value,
        prepared: false, cleaned: false, connections: [], artifacts: [], transitions: {}, checks: [] }
      safeWrite(stateFile, newState, { privateFile: true, exclusive: true })
      state = newState
    } else {
      const loaded = privateRead(stateFile, true)
      requireCheck(loaded.schemaVersion === 1 && loaded.binding === identity.value && loaded.synthetic === synthetic &&
        typeof loaded.nonce === 'string' && /^[0-9a-f-]{36}$/.test(loaded.nonce) && Array.isArray(loaded.connections) &&
        Array.isArray(loaded.artifacts) && Array.isArray(loaded.checks), 'STATE_BINDING_INVALID')
      const prefix = `staging-${loaded.nonce}-`
      requireCheck(loaded.connections.every((r) => r.owner === 'a' && isId(r.id) && DB_NAMES.includes(r.dbKey) &&
        Array.isArray(r.names) && r.names.length > 0 && r.names.every((name) => typeof name === 'string' && name.startsWith(prefix))) &&
        loaded.artifacts.every((r) => r.owner === 'a' && /^artifact_[A-Za-z0-9_-]{16,128}$/.test(r.id) &&
          typeof r.filename === 'string' && r.filename.startsWith(prefix)), 'STATE_RESOURCES_INVALID')
      state = loaded
    }
  })
  if (!stateReady.passed) return finish()

  for (const owner of ['a', 'b']) await step(`authentication.owner-${owner}`, async () => { await list(owner) })
  await step('authentication.missing', async () => { expect(await request('a', '/connections', 'GET', undefined, undefined, ''), 401, false) })
  await step('authentication.invalid-signature', async () => {
    const parts = tokens.a.split('.')
    requireCheck(parts.length === 3 && parts[2].length > 0, 'TOKEN_CLAIMS_INVALID')
    // Corrupt a real credential's signature; never mint a fake JWT for an external service.
    parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`
    expect(await request('a', '/connections', 'GET', undefined, undefined, parts.join('.')), 401, false)
  })
  if (checks.some((entry) => entry.result === 'failed')) return finish()

  if (phase === 'cleanup') {
    for (const resource of [...state.artifacts]) await step('cleanup.artifact', async () => {
      const response = await request('a', artifactPath(resource.id))
      if (response.status !== 404) {
        const item = expect(response)
        requireCheck(item.filename === resource.filename, 'RESOURCE_OWNERSHIP_MISMATCH')
        expect(await request('a', artifactPath(resource.id), 'DELETE'))
      }
      state.artifacts = state.artifacts.filter((entry) => entry !== resource)
      save()
    })
    for (const resource of [...state.connections]) await step('cleanup.connection', () => removeConnection(resource))
    return finish()
  }

  if (phase !== 'prepare') {
    const receiptCheck = await step('transition.receipt', async () => {
      requireCheck(state.prepared && !state.cleaned, 'PREPARE_REQUIRED')
      const receiptFile = phase === 'recover' ? config.driverFault?.receiptFile : options.receiptFile ?? config.transitionReceiptFile
      requireCheck(receiptFile, 'TRANSITION_RECEIPT_REQUIRED')
      const receipt = privateRead(receiptFile, true)
      const transition = phase === 'recover' ? 'driver-fault' : phase === 'rollback' ? 'rollback' : receipt.transition
      requireCheck(receipt.schemaVersion === 1 && receipt.nonce === state.nonce && receipt.completed === true &&
        receipt.transition === transition && ['restart', 'rollback', 'driver-fault'].includes(transition), 'TRANSITION_RECEIPT_INVALID')
      requireCheck(!state.transitions[transition], 'TRANSITION_ALREADY_VERIFIED')
      if (transition === 'rollback') requireCheck(state.transitions.restart === true, 'RESTART_VERIFICATION_REQUIRED')
      if (transition !== 'driver-fault') {
        const image = (value) => typeof value === 'string' && /(?:^|@)sha256:[0-9a-f]{64}$/.test(value)
        requireCheck(image(receipt.fromImage) && image(receipt.toImage), 'TRANSITION_IMAGE_INVALID')
        requireCheck(transition === 'restart' ? receipt.fromImage === receipt.toImage : receipt.fromImage !== receipt.toImage, 'TRANSITION_IMAGE_MISMATCH')
      }
      return transition
    })
    if (!receiptCheck.passed) return finish()
    const probe = state.connections.find((resource) => resource.probe === true)
    const probeCheck = await step('transition.probe', async () => {
      requireCheck(probe, 'PROBE_MISSING')
      const item = await ownConnection(probe)
      requireCheck(item.persisted === true && (!probe.secretExpected || item.secretStored === true), 'PROBE_PERSISTENCE_FAILED')
      const connected = expect(await request('a', pathFor(probe.id, 'connect'), 'POST'))
      requireCheck(connected.id === probe.id && connected.connected === true && probe.names.includes(connected.name), 'PROBE_RECONNECT_FAILED')
      await canary(probe)
    })
    if (probeCheck.passed) state.transitions[receiptCheck.value] = true
    return finish()
  }

  const configuredNames = DB_NAMES.filter((name) => config.databases[name]?.config)
  for (const name of DB_NAMES) if (!config.databases[name]?.config) skip(`database.${name}`, 'OPTIONAL_DATABASE_NOT_CONFIGURED')
  const baselineA = await step('connections.baseline', () => list('a'))
  if (!baselineA.passed) return finish()
  for (const name of configuredNames) {
    const db = config.databases[name]
    const label = `staging-${state.nonce}-${name}`
    const body = { config: { ...db.config, name: label }, ...(Object.keys(db.secret ?? {}).length ? { secret: db.secret } : {}) }
    const tested = await step(`database.${name}.test`, async () => {
      const value = expect(await request('a', '/connections/test', 'POST', body))
      requireCheck(value?.ok === true, 'DATABASE_TEST_FAILED')
    })
    if (!tested.passed) continue
    let resource
    const created = await step(`database.${name}.create`, async () => {
      const item = expect(await request('a', '/connections', 'POST', body), 201)
      requireCheck(isId(item?.id) && item.name === label && !baselineA.value.some((entry) => entry.id === item.id), 'CREATED_RESOURCE_INVALID')
      resource = { owner: 'a', id: item.id, names: [label, `${label}-updated`], dbKey: name,
        secretExpected: Object.keys(db.secret ?? {}).length > 0, probe: state.connections.every((entry) => !entry.probe) }
      state.connections.push(resource)
      save()
      requireCheck(item.connected === true && item.persisted === true && (!resource.secretExpected || item.secretStored === true), 'DATABASE_CONNECT_FAILED')
    })
    if (!created.passed) continue
    await step(`database.${name}.list`, async () => { requireCheck((await ownConnection(resource)).connected === true, 'CONNECTION_NOT_CONNECTED') })
    await step(`database.${name}.rpc`, () => canary(resource))
    for (const [method, action] of [['POST', 'connect'], ['POST', 'disconnect'], ['PATCH', ''], ['DELETE', '']]) {
      await step(`database.${name}.foreign-${action || method.toLowerCase()}`, async () => {
        requireCheck(!(await list('b')).some((entry) => entry.id === resource.id), 'FOREIGN_ID_COLLISION')
        expect(await request('b', pathFor(resource.id, action), method, method === 'PATCH' ? { config: { name: label } } : undefined), 404, false)
      })
    }
    await step(`database.${name}.foreign-rpc`, async () => {
      requireCheck(!(await list('b')).some((entry) => entry.id === resource.id), 'FOREIGN_ID_COLLISION')
      expect(await request('b', '/rpc', 'POST', { id: randomUUID(), method: 'listChildren', args: [`connection:${resource.id}`] }), 404, false)
    })
    for (const [badName, patch] of [
      ['secret', { secretPatch: { unrecognized: 'staging-rejected' } }],
      ['option', { config: { options: { ...db.config.options, password: 'staging-rejected' } } }],
      ['path', { config: { options: { ...db.config.options, file: '/staging-forbidden/probe' } } }]
    ]) await step(`database.${name}.reject-${badName}`, async () => {
      await ownConnection(resource)
      expect(await request('a', pathFor(resource.id), 'PATCH', { config: {}, ...patch }), 400, false)
    })
    await step(`database.${name}.update`, async () => {
      await ownConnection(resource)
      const item = expect(await request('a', pathFor(resource.id), 'PATCH', { config: { name: resource.names[1] } }))
      requireCheck(item.id === resource.id && item.name === resource.names[1], 'CONNECTION_UPDATE_FAILED')
    })
    await step(`database.${name}.disconnect`, async () => {
      await ownConnection(resource)
      requireCheck(expect(await request('a', pathFor(resource.id, 'disconnect'), 'POST')).connected === false, 'CONNECTION_DISCONNECT_FAILED')
    })
    await step(`database.${name}.reconnect`, async () => {
      await ownConnection(resource)
      requireCheck(expect(await request('a', pathFor(resource.id, 'connect'), 'POST')).connected === true, 'CONNECTION_RECONNECT_FAILED')
      await canary(resource)
    })
    if (!resource.probe) await step(`database.${name}.delete`, () => removeConnection(resource))
    if (db.negativeConfig) await step(`database.${name}.negative`, async () => {
      const negative = db.negativeConfig
      const result = await request('a', '/connections/test', 'POST', { config: { ...negative.config, name: `${label}-negative` }, secret: negative.secret })
      requireCheck(result.status === 200 && result.json?.ok === true && result.json.value?.ok === false, 'NEGATIVE_CONNECTION_NOT_REJECTED', result.status)
    })
    else skip(`database.${name}.negative`)
  }
  if (config.artifacts?.required !== false) {
    let resource
    let upload
    let download
    const content = Buffer.from(`staging-${state.nonce}\n`)
    const filename = `staging-${state.nonce}-artifact.txt`
    const uploaded = await step('artifact.upload-ticket', async () => {
      upload = expect(await request('a', '/artifacts/upload-tickets', 'POST', { purpose: 'import-source', filename,
        expectedBytes: content.length, expectedSha256: digest(content) }), 201)
      const id = upload?.artifact?.artifactId
      requireCheck(typeof id === 'string' && /^artifact_[A-Za-z0-9_-]{16,128}$/.test(id) && upload.artifact.filename === filename, 'ARTIFACT_TICKET_INVALID')
      resource = { owner: 'a', id, filename }
      state.artifacts.push(resource); save()
      requireCheck(upload.uploadUrl === `/artifacts/uploads/${id}` && upload.method === 'PUT' &&
        /^Bearer [^\s]+$/.test(upload.headers?.['x-dbstudio-artifact-ticket']), 'ARTIFACT_TICKET_INVALID')
    })
    if (uploaded.passed) {
      const ticket = { 'x-dbstudio-artifact-ticket': upload.headers['x-dbstudio-artifact-ticket'] }
      await step('artifact.foreign-upload', async () => { expect(await request('b', upload.uploadUrl, 'PUT', content, ticket), 404, false) })
      const written = await step('artifact.upload', async () => {
        const value = expect(await request('a', upload.uploadUrl, 'PUT', content, ticket))
        requireCheck(value?.sha256 === digest(content) && value.sizeBytes === content.length && value.status === 'ready', 'ARTIFACT_UPLOAD_INVALID')
      })
      if (written.passed) {
        await step('artifact.upload-once', async () => { expect(await request('a', upload.uploadUrl, 'PUT', content, ticket), 401, false) })
        for (const [method, path] of [['GET', artifactPath(resource.id)], ['DELETE', artifactPath(resource.id)], ['POST', `/artifacts/download-tickets/${resource.id}`]]) {
          await step(`artifact.foreign-${method.toLowerCase()}`, async () => { expect(await request('b', path, method), 404, false) })
        }
        const ticketed = await step('artifact.download-ticket', async () => {
          download = expect(await request('a', `/artifacts/download-tickets/${resource.id}`, 'POST'), 201)
          requireCheck(download?.downloadUrl === `/artifacts/downloads/${resource.id}` && download.method === 'GET' &&
            /^Bearer [^\s]+$/.test(download.headers?.['x-dbstudio-artifact-ticket']), 'ARTIFACT_TICKET_INVALID')
        })
        if (ticketed.passed) {
          const headers = { 'x-dbstudio-artifact-ticket': download.headers['x-dbstudio-artifact-ticket'] }
          await step('artifact.foreign-download', async () => { expect(await request('b', download.downloadUrl, 'GET', undefined, headers), 404, false) })
          await step('artifact.download', async () => {
            const result = await request('a', download.downloadUrl, 'GET', undefined, headers)
            requireCheck(result.status === 200 && result.bytes.equals(content), 'ARTIFACT_DOWNLOAD_INVALID', result.status)
          })
          await step('artifact.download-once', async () => { expect(await request('a', download.downloadUrl, 'GET', undefined, headers), 401, false) })
        }
      }
      await step('artifact.delete', async () => {
        const item = expect(await request('a', artifactPath(resource.id)))
        requireCheck(item.filename === resource.filename, 'RESOURCE_OWNERSHIP_MISMATCH')
        expect(await request('a', artifactPath(resource.id), 'DELETE'))
        expect(await request('a', artifactPath(resource.id)), 404, false)
        state.artifacts = state.artifacts.filter((entry) => entry !== resource); save()
      })
    }
  } else skip('artifact', 'OPTIONAL_ARTIFACT_NOT_CONFIGURED')
  if (config.driverFault?.required) skip('driver-fault', 'REQUIRED_EXTERNAL_TRANSITION_PENDING')
  return finish()
}
