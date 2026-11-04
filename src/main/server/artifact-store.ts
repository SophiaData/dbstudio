/**
 * owner-bound 的本地 artifact store。
 *
 * artifact id 只作为经过校验的文件名使用；owner 目录由 composition 为每个
 * principal 单独创建。上传和下载都必须先拿短时效、内存内的一次性 ticket。
 */

import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BackendError } from '../../backend/contract/errors'
import {
  ARTIFACT_TICKET_HEADER,
  isArtifactId,
  isSha256,
  type ArtifactDownloadTicket,
  type ArtifactMetadata,
  type ArtifactPurpose,
  type ArtifactUploadTicket,
  type CreateArtifactUploadRequest
} from '../../backend/contract/artifact'
import type { Readable } from 'node:stream'

export const DEFAULT_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024
export const DEFAULT_ARTIFACT_TTL_MS = 15 * 60 * 1000
export const MAX_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_ARTIFACT_MAX_COUNT = 100
export const DEFAULT_ARTIFACT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024
export const DEFAULT_ARTIFACT_MAX_CONCURRENT_UPLOADS = 4
export const DEFAULT_ARTIFACT_SWEEP_INTERVAL_MS = 60 * 1000

export class ArtifactStoreError extends BackendError {
  constructor(
    payload: ConstructorParameters<typeof BackendError>[0],
    readonly statusCode = 400
  ) {
    super(payload)
    this.name = 'ArtifactStoreError'
  }
}

export interface ArtifactStoreOptions {
  readonly baseDir: string
  readonly maxBytes?: number
  readonly defaultTtlMs?: number
  readonly maxArtifacts?: number
  readonly maxTotalBytes?: number
  readonly maxConcurrentUploads?: number
  readonly sweepIntervalMs?: number
  readonly now?: () => number
}

export interface OpenArtifactDownload {
  readonly artifact: ArtifactMetadata
  readonly stream: Readable
}

type Ticket =
  | {
      readonly kind: 'upload'
      readonly artifactId: ArtifactMetadata['artifactId']
      readonly purpose: ArtifactPurpose
      readonly expiresAt: number
    }
  | {
      readonly kind: 'download'
      readonly artifactId: ArtifactMetadata['artifactId']
      readonly expiresAt: number
    }

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`${name} 必须是正整数`)
  }
  return resolved
}

function artifactError(
  code: ConstructorParameters<typeof BackendError>[0]['code'],
  message: string,
  statusCode = 400
): ArtifactStoreError {
  return new ArtifactStoreError({ code, message }, statusCode)
}

function ticketValue(): string {
  return randomBytes(32).toString('base64url')
}

function artifactValue(): ArtifactMetadata['artifactId'] {
  return `artifact_${randomBytes(18).toString('base64url')}`
}

function safeFilename(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw artifactError('invalid-argument', 'artifact filename 必须是字符串')
  }
  const filename = value.trim()
  if (filename.length === 0) return null
  if (filename.length > 255 || filename === '.' || filename === '..' || /[\\/\0]/.test(filename)) {
    throw artifactError('invalid-argument', 'artifact filename 不合法')
  }
  return filename
}

function safeMediaType(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') {
    throw artifactError('invalid-argument', 'artifact mediaType 必须是字符串')
  }
  const mediaType = value.trim()
  if (mediaType.length === 0) return null
  if (mediaType.length > 200 || /[\r\n]/.test(mediaType)) {
    throw artifactError('invalid-argument', 'artifact mediaType 不合法')
  }
  return mediaType
}

function safeExpectedBytes(value: unknown, maxBytes: number): number | null {
  if (value === undefined) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
    throw artifactError('invalid-argument', 'expectedBytes 超出 artifact 大小上限')
  }
  return value
}

function safeTtl(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1000 ||
    value > MAX_ARTIFACT_TTL_MS
  ) {
    throw artifactError('invalid-argument', 'expiresInMs 超出允许范围')
  }
  return value
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(temporary, value, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return
  await once(stream, 'drain')
}

async function finishStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  stream.end()
  await once(stream, 'finish')
}

export class LocalArtifactStore {
  readonly #rootDir: string
  readonly #maxBytes: number
  readonly #defaultTtlMs: number
  readonly #maxArtifacts: number
  readonly #maxTotalBytes: number
  readonly #maxConcurrentUploads: number
  readonly #sweepIntervalMs: number
  readonly #now: () => number
  readonly #tickets = new Map<string, Ticket>()
  readonly #activeUploads = new Set<string>()
  readonly #uploadBytes = new Map<string, number>()
  readonly #locks = new Map<string, Promise<void>>()
  #quotaTail: Promise<void> = Promise.resolve()
  #sweepTimer: ReturnType<typeof setInterval> | undefined
  #sweepInFlight: Promise<void> | undefined

  async #withQuotaLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#quotaTail
    let release!: () => void
    this.#quotaTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async #withArtifactLock<T>(artifactId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(artifactId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.#locks.set(artifactId, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#locks.get(artifactId) === current) this.#locks.delete(artifactId)
    }
  }

  async #quotaSnapshot(): Promise<{ count: number; bytes: number }> {
    let entries: string[]
    try {
      entries = await readdir(this.#rootDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { count: 0, bytes: 0 }
      throw artifactError('internal', 'artifact 配额读取失败', 500)
    }
    let count = 0
    let bytes = 0
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const metadata = JSON.parse(await readFile(join(this.#rootDir, entry), 'utf8')) as ArtifactMetadata
        if (metadata.status === 'deleted' || metadata.status === 'expired' || metadata.status === 'failed') continue
        count += 1
        if (metadata.sizeBytes !== null) bytes += metadata.sizeBytes
      } catch {
        // Ignore incomplete/corrupt metadata; normal reads still fail closed.
      }
    }
    return { count, bytes }
  }

  constructor(options: ArtifactStoreOptions) {
    if (!options || typeof options.baseDir !== 'string' || options.baseDir.trim() === '') {
      throw new Error('artifact store 缺少 baseDir')
    }
    this.#rootDir = join(options.baseDir, 'artifacts')
    this.#maxBytes = positiveLimit(options.maxBytes, DEFAULT_ARTIFACT_MAX_BYTES, 'maxBytes')
    this.#defaultTtlMs = safeTtl(options.defaultTtlMs, DEFAULT_ARTIFACT_TTL_MS)
    this.#maxArtifacts = positiveLimit(options.maxArtifacts, DEFAULT_ARTIFACT_MAX_COUNT, 'maxArtifacts')
    this.#maxTotalBytes = positiveLimit(options.maxTotalBytes, DEFAULT_ARTIFACT_MAX_TOTAL_BYTES, 'maxTotalBytes')
    this.#maxConcurrentUploads = positiveLimit(
      options.maxConcurrentUploads,
      DEFAULT_ARTIFACT_MAX_CONCURRENT_UPLOADS,
      'maxConcurrentUploads'
    )
    this.#sweepIntervalMs = positiveLimit(
      options.sweepIntervalMs,
      DEFAULT_ARTIFACT_SWEEP_INTERVAL_MS,
      'sweepIntervalMs'
    )
    this.#now = options.now ?? Date.now
  }

  #metadataPath(artifactId: ArtifactMetadata['artifactId']): string {
    return join(this.#rootDir, `${artifactId}.json`)
  }

  #dataPath(artifactId: ArtifactMetadata['artifactId']): string {
    return join(this.#rootDir, `${artifactId}.bin`)
  }

  async #readMetadata(artifactId: ArtifactMetadata['artifactId']): Promise<ArtifactMetadata> {
    if (!isArtifactId(artifactId)) {
      throw artifactError('invalid-argument', 'artifact id 不合法')
    }
    try {
      const parsed = JSON.parse(await readFile(this.#metadataPath(artifactId), 'utf8')) as ArtifactMetadata
      if (parsed.artifactId !== artifactId || parsed.status === 'deleted') {
        throw artifactError('not-found', 'artifact 不存在', 404)
      }
      return parsed
    } catch (error) {
      if (error instanceof ArtifactStoreError) throw error
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw artifactError('not-found', 'artifact 不存在', 404)
      }
      throw artifactError('internal', 'artifact metadata 读取失败', 500)
    }
  }

  async #writeMetadata(metadata: ArtifactMetadata): Promise<void> {
    await mkdir(this.#rootDir, { recursive: true, mode: 0o700 })
    await writeAtomic(this.#metadataPath(metadata.artifactId), `${JSON.stringify(metadata)}\n`)
  }

  async #expireIfNeeded(metadata: ArtifactMetadata): Promise<ArtifactMetadata> {
    if (
      metadata.status === 'expired' ||
      metadata.status === 'failed' ||
      metadata.status === 'consumed' ||
      metadata.status === 'uploading' ||
      this.#activeUploads.has(metadata.artifactId) ||
      this.#now() < metadata.expiresAt
    ) {
      return metadata
    }
    const expired = { ...metadata, status: 'expired' as const }
    await rm(this.#dataPath(metadata.artifactId), { force: true })
    await this.#writeMetadata(expired)
    return expired
  }

  async #runSweep(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.#rootDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return
      throw artifactError('internal', 'artifact 过期清理失败', 500)
    }

    const now = this.#now()
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.endsWith('.json')) return
        const artifactId = entry.slice(0, -'.json'.length)
        if (!isArtifactId(artifactId)) return
        let metadata: ArtifactMetadata
        try {
          metadata = JSON.parse(await readFile(this.#metadataPath(artifactId), 'utf8')) as ArtifactMetadata
        } catch {
          return
        }
        if (
          metadata.expiresAt > now ||
          metadata.status === 'deleted' ||
          (metadata.status === 'uploading' && this.#activeUploads.has(artifactId))
        ) return
        for (const [token, ticket] of this.#tickets) {
          if (ticket.artifactId === artifactId) this.#tickets.delete(token)
        }
        await rm(this.#dataPath(artifactId), { force: true })
        await rm(this.#metadataPath(artifactId), { force: true })
      })
    )
    await Promise.all(
      entries
        .filter((entry) => entry.includes('.tmp-'))
        .map(async (entry) => {
          const artifactId = entry.split('.bin.tmp-', 1)[0]
          if (isArtifactId(artifactId) && this.#activeUploads.has(artifactId)) return
          try {
            const info = await stat(join(this.#rootDir, entry))
            if (info.mtimeMs + DEFAULT_ARTIFACT_TTL_MS > now) return
            await rm(join(this.#rootDir, entry), { force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return
          }
        })
    )
  }

  async sweepExpired(): Promise<void> {
    if (this.#sweepInFlight) return this.#sweepInFlight
    const sweep = this.#runSweep()
    this.#sweepInFlight = sweep
    try {
      await sweep
    } finally {
      if (this.#sweepInFlight === sweep) this.#sweepInFlight = undefined
    }
  }

  startSweep(): void {
    if (this.#sweepTimer) return
    void this.sweepExpired().catch(() => undefined)
    this.#sweepTimer = setInterval(() => {
      void this.sweepExpired().catch(() => undefined)
    }, this.#sweepIntervalMs)
    this.#sweepTimer.unref?.()
  }

  stopSweep(): void {
    if (!this.#sweepTimer) return
    clearInterval(this.#sweepTimer)
    this.#sweepTimer = undefined
  }

  async createUploadTicket(request: CreateArtifactUploadRequest): Promise<ArtifactUploadTicket> {
    await this.sweepExpired()
    if (request?.purpose !== 'import-source') {
      throw artifactError('invalid-argument', '远程 upload 只允许 import-source artifact')
    }
    const maxBytes = this.#maxBytes
    const expectedBytes = safeExpectedBytes(request.expectedBytes, maxBytes)
    const expectedSha256 = request.expectedSha256 === undefined ? null : request.expectedSha256
    if (expectedSha256 !== null && !isSha256(expectedSha256)) {
      throw artifactError('invalid-argument', 'expectedSha256 必须是 64 位十六进制摘要')
    }
    const createdAt = this.#now()
    const expiresAt = createdAt + safeTtl(request.expiresInMs, this.#defaultTtlMs)
    const artifactId = artifactValue()
    const metadata: ArtifactMetadata = {
      artifactId,
      purpose: request.purpose,
      status: 'pending',
      filename: safeFilename(request.filename),
      mediaType: safeMediaType(request.mediaType),
      sizeBytes: expectedBytes,
      sha256: expectedSha256,
      createdAt,
      expiresAt
    }
    return this.#withQuotaLock(async () => {
      const quota = await this.#quotaSnapshot()
      if (quota.count >= this.#maxArtifacts) {
        throw artifactError('conflict', 'artifact 数量已达到 owner 上限', 409)
      }
      if (expectedBytes !== null && quota.bytes + expectedBytes > this.#maxTotalBytes) {
        throw artifactError('invalid-argument', 'artifact 总容量已达到 owner 上限', 413)
      }
      await this.#writeMetadata(metadata)
      const token = ticketValue()
      this.#tickets.set(token, {
        kind: 'upload',
        artifactId,
        purpose: request.purpose,
        expiresAt
      })
      return {
        artifact: metadata,
        method: 'PUT' as const,
        uploadUrl: `/artifacts/uploads/${artifactId}`,
        headers: {
          'content-type': metadata.mediaType ?? 'application/octet-stream',
          [ARTIFACT_TICKET_HEADER]: `Bearer ${token}`
        },
        maxBytes,
        expiresAt
      }
    })
  }

  async inspectArtifact(artifactId: ArtifactMetadata['artifactId']): Promise<ArtifactMetadata> {
    return this.#expireIfNeeded(await this.#readMetadata(artifactId))
  }

  async upload(
    artifactId: ArtifactMetadata['artifactId'],
    token: string,
    source: AsyncIterable<Uint8Array | string>
  ): Promise<ArtifactMetadata> {
    return this.#withArtifactLock(artifactId, async () => {
    const ticket = this.#tickets.get(token)
    if (!ticket || ticket.kind !== 'upload' || ticket.artifactId !== artifactId) {
      throw artifactError('unauthorized', 'artifact upload ticket 无效或已使用', 401)
    }
    this.#tickets.delete(token)
    if (this.#now() >= ticket.expiresAt) {
      throw artifactError('timeout', 'artifact upload ticket 已过期', 410)
    }

    const current = await this.#expireIfNeeded(await this.#readMetadata(artifactId))
    if (current.status !== 'pending') {
      throw artifactError('conflict', 'artifact 当前状态不可上传', 409)
    }
    if (this.#activeUploads.size >= this.#maxConcurrentUploads) {
      throw artifactError('conflict', 'artifact 并发上传已达到 owner 上限', 409)
    }
    this.#activeUploads.add(artifactId)
    const uploading: ArtifactMetadata = { ...current, status: 'uploading', sizeBytes: null, sha256: null }
    await this.#writeMetadata(uploading)
    const temporaryPath = `${this.#dataPath(artifactId)}.tmp-${randomBytes(8).toString('hex')}`
    const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 })
    const hash = createHash('sha256')
    let sizeBytes = 0
    try {
      for await (const value of source) {
        const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
        sizeBytes += chunk.byteLength
        if (sizeBytes > this.#maxBytes) {
          throw artifactError('invalid-argument', 'artifact 上传超过大小上限', 413)
        }
        this.#uploadBytes.set(artifactId, sizeBytes)
        const quota = await this.#quotaSnapshot()
        const inFlightBytes = [...this.#uploadBytes.values()].reduce((total, value) => total + value, 0)
        if (quota.bytes + inFlightBytes > this.#maxTotalBytes) {
          throw artifactError('invalid-argument', 'artifact 总容量已达到 owner 上限', 413)
        }
        hash.update(chunk)
        await writeChunk(output, chunk)
      }
      await finishStream(output)
      const sha256 = hash.digest('hex')
      if (this.#now() >= ticket.expiresAt) {
        throw artifactError('timeout', 'artifact upload 已超过 TTL', 410)
      }
      if (current.sizeBytes !== null && current.sizeBytes !== sizeBytes) {
        throw artifactError('invalid-argument', 'artifact 实际大小与 expectedBytes 不一致', 400)
      }
      if (current.sha256 !== null && current.sha256.toLowerCase() !== sha256) {
        throw artifactError('invalid-argument', 'artifact sha256 与 expectedSha256 不一致', 400)
      }
      await rename(temporaryPath, this.#dataPath(artifactId))
      const ready: ArtifactMetadata = { ...current, status: 'ready', sizeBytes, sha256 }
      await this.#writeMetadata(ready)
      return ready
    } catch (error) {
      output.destroy()
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      await rm(this.#dataPath(artifactId), { force: true }).catch(() => undefined)
      const terminalStatus = error instanceof ArtifactStoreError && error.code === 'timeout' ? 'expired' : 'failed'
      const failed: ArtifactMetadata = { ...uploading, status: terminalStatus, sizeBytes: null, sha256: null }
      await this.#writeMetadata(failed).catch(() => undefined)
      throw error
    } finally {
      this.#activeUploads.delete(artifactId)
      this.#uploadBytes.delete(artifactId)
    }
    })
  }

  async createDownloadTicket(artifactId: ArtifactMetadata['artifactId']): Promise<ArtifactDownloadTicket> {
    const artifact = await this.#expireIfNeeded(await this.#readMetadata(artifactId))
    if (artifact.status !== 'ready') {
      throw artifactError('conflict', 'artifact 尚未准备好下载', 409)
    }
    const token = ticketValue()
    this.#tickets.set(token, {
      kind: 'download',
      artifactId,
      expiresAt: artifact.expiresAt
    })
    return {
      artifact,
      method: 'GET',
      downloadUrl: `/artifacts/downloads/${artifactId}`,
      headers: {
        [ARTIFACT_TICKET_HEADER]: `Bearer ${token}`
      },
      expiresAt: artifact.expiresAt
    }
  }

  async openDownload(
    artifactId: ArtifactMetadata['artifactId'],
    token: string
  ): Promise<OpenArtifactDownload> {
    const ticket = this.#tickets.get(token)
    if (!ticket || ticket.kind !== 'download' || ticket.artifactId !== artifactId) {
      throw artifactError('unauthorized', 'artifact download ticket 无效或已使用', 401)
    }
    this.#tickets.delete(token)
    if (this.#now() >= ticket.expiresAt) {
      throw artifactError('timeout', 'artifact download ticket 已过期', 410)
    }
    const artifact = await this.#expireIfNeeded(await this.#readMetadata(artifactId))
    if (artifact.status !== 'ready') {
      throw artifactError('conflict', 'artifact 当前状态不可下载', 409)
    }
    try {
      const info = await lstat(this.#dataPath(artifactId))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file')
    } catch {
      throw artifactError('not-found', 'artifact 数据不存在', 404)
    }
    return { artifact, stream: createReadStream(this.#dataPath(artifactId)) }
  }

  async deleteArtifact(artifactId: ArtifactMetadata['artifactId']): Promise<void> {
    await this.#withArtifactLock(artifactId, async () => {
      const metadata = await this.#readMetadata(artifactId)
      for (const [token, ticket] of this.#tickets) {
        if (ticket.artifactId === artifactId) this.#tickets.delete(token)
      }
      await this.#writeMetadata({ ...metadata, status: 'deleted' })
      await rm(this.#dataPath(artifactId), { force: true })
    })
  }

  dispose(): void {
    this.stopSweep()
    this.#tickets.clear()
  }
}
