/**
 * 远程文件 artifact contract。
 *
 * HTTP/Tauri 不能把 server 本机的 sourcePath / destinationPath 当作远程 API
 * 参数。文件先通过短时效 ticket 进入 owner-bound artifact store，再把 opaque
 * artifactId 交给导入/导出 job；artifact 本身不编码 owner，也不接受调用方自选
 * 的磁盘路径。
 */

/** artifact id 的稳定线格式；真实值应由 server 使用密码学随机源生成。 */
export type ArtifactId = `artifact_${string}`

export type ArtifactPurpose = 'import-source' | 'export-result'

/** bearer ticket 只允许通过该请求头传输，不放入 URL query。 */
export const ARTIFACT_TICKET_HEADER = 'x-dbstudio-artifact-ticket'

export type ArtifactStatus =
  | 'pending'
  | 'uploading'
  | 'ready'
  | 'consumed'
  | 'expired'
  | 'failed'
  | 'deleted'

export interface ArtifactReference {
  readonly artifactId: ArtifactId
  /** 防止把一个 job 预期的用途换成另一种 artifact。 */
  readonly purpose: ArtifactPurpose
}

/** 上传申请；不包含本机路径。 */
export interface CreateArtifactUploadRequest {
  /** 上传文件的用途；服务端不会接受未声明用途的 artifact。 */
  readonly purpose: ArtifactPurpose
  readonly filename?: string
  readonly mediaType?: string
  readonly expectedBytes?: number
  readonly expectedSha256?: string
  readonly expiresInMs?: number
}

/** 上传完成后由 server 返回的 owner-bound artifact 元数据。 */
export interface ArtifactMetadata {
  readonly artifactId: ArtifactId
  readonly purpose: ArtifactPurpose
  readonly status: ArtifactStatus
  readonly filename: string | null
  readonly mediaType: string | null
  readonly sizeBytes: number | null
  readonly sha256: string | null
  readonly createdAt: number
  readonly expiresAt: number
}

/** 只允许写入该 artifact 的一次性短时效 ticket。 */
export interface ArtifactUploadTicket {
  readonly artifact: ArtifactMetadata
  readonly method: 'PUT'
  readonly uploadUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly maxBytes: number
  readonly expiresAt: number
}

/** 只允许读取该 artifact 的一次性短时效 ticket。 */
export interface ArtifactDownloadTicket {
  readonly artifact: ArtifactMetadata
  readonly method: 'GET'
  readonly downloadUrl: string
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: number
}

/** 远程导入请求的文件部分；其余数据库目标字段由未来 job contract 定义。 */
export interface RemoteImportArtifactInput {
  readonly source: ArtifactReference & { readonly purpose: 'import-source' }
}

/** 远程导出结果的文件部分；job 完成后产生 `export-result` artifact。 */
export interface RemoteExportArtifactOutput {
  readonly result: ArtifactReference & { readonly purpose: 'export-result' }
}

/** artifact API 的最小语义；owner 由 request context 注入，不进入参数。 */
export interface ArtifactApi {
  createUploadTicket(request: CreateArtifactUploadRequest): Promise<ArtifactUploadTicket>
  inspectArtifact(artifactId: ArtifactId): Promise<ArtifactMetadata>
  createDownloadTicket(artifactId: ArtifactId): Promise<ArtifactDownloadTicket>
  deleteArtifact(artifactId: ArtifactId): Promise<void>
}

const ARTIFACT_ID_PATTERN = /^artifact_[A-Za-z0-9_-]{16,128}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/i

export function isArtifactId(value: unknown): value is ArtifactId {
  return typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value)
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

/** 只接受 ticket / job 之间传递的 opaque artifact reference。 */
export function isArtifactReference(value: unknown): value is ArtifactReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const reference = value as Partial<ArtifactReference>
  return (
    isArtifactId(reference.artifactId) &&
    (reference.purpose === 'import-source' || reference.purpose === 'export-result')
  )
}
