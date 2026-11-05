/**
 * owner 级资源治理边界。
 *
 * 认证 provider 只产生 principal；本模块负责 owner 生命周期、资源租约和审计事件，
 * 不绑定 JWT/mTLS，也不直接操作连接或 artifact 实现。
 */

export interface OwnerQuota {
  readonly maxConcurrentRequests?: number
  readonly maxConnections?: number
  readonly maxStorageBytes?: number
}

export const DEFAULT_OWNER_QUOTA: Required<OwnerQuota> = {
  maxConcurrentRequests: 64,
  maxConnections: 32,
  maxStorageBytes: 1024 * 1024 * 1024
}

export interface OwnerAuditEvent {
  readonly type:
    | 'owner-created'
    | 'owner-disposed'
    | 'request-accepted'
    | 'request-rejected'
    | 'authentication-failed'
    | 'connection-reserved'
    | 'connection-released'
    | 'storage-reserved'
    | 'storage-released'
  readonly ownerId: string
  readonly requestId?: string
  readonly amount?: number
  readonly reason?: string
  readonly at: number
}

export interface OwnerGovernanceOptions {
  readonly quota?: OwnerQuota
  readonly audit?: (event: OwnerAuditEvent) => void
}

export interface OwnerLease {
  readonly release: () => void
}

export class OwnerQuotaError extends Error {
  constructor(
    readonly resource: 'requests' | 'connections' | 'storage',
    message: string
  ) {
    super(message)
    this.name = 'OwnerQuotaError'
  }
}

interface OwnerState {
  concurrentRequests: number
  connections: number
  storageBytes: number
}

function normalizeOwnerId(ownerId: string): string {
  const normalized = ownerId.trim()
  if (!normalized) throw new Error('ownerId 不能为空')
  return normalized
}

function positiveQuota(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`)
  return value
}

function nonNegativeAmount(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`)
  return value
}

export class OwnerGovernance {
  private readonly states = new Map<string, OwnerState>()
  private readonly quota: Required<OwnerQuota>
  private disposed = false

  constructor(options: OwnerGovernanceOptions = {}) {
    this.quota = {
      maxConcurrentRequests: positiveQuota(options.quota?.maxConcurrentRequests, 'maxConcurrentRequests') ?? DEFAULT_OWNER_QUOTA.maxConcurrentRequests,
      maxConnections: positiveQuota(options.quota?.maxConnections, 'maxConnections') ?? DEFAULT_OWNER_QUOTA.maxConnections,
      maxStorageBytes: positiveQuota(options.quota?.maxStorageBytes, 'maxStorageBytes') ?? DEFAULT_OWNER_QUOTA.maxStorageBytes
    }
    this.audit = options.audit
  }

  private readonly audit?: (event: OwnerAuditEvent) => void

  private stateFor(ownerId: string): { id: string; state: OwnerState } {
    if (this.disposed) throw new Error('owner governance 已关闭')
    const id = normalizeOwnerId(ownerId)
    let state = this.states.get(id)
    if (!state) {
      state = { concurrentRequests: 0, connections: 0, storageBytes: 0 }
      this.states.set(id, state)
      this.emit({ type: 'owner-created', ownerId: id })
    }
    return { id, state }
  }

  private emit(event: Omit<OwnerAuditEvent, 'at'>): void {
    try {
      this.audit?.({ ...event, at: Date.now() })
    } catch {
      // 审计 sink 不能破坏资源计数；失败交给上层可观测性记录。
    }
  }

  ensureOwner(ownerId: string): void {
    this.stateFor(ownerId)
  }

  quotaFor(ownerId: string): Required<OwnerQuota> {
    this.stateFor(ownerId)
    return { ...this.quota }
  }

  recordAuthenticationFailure(requestId?: string, ownerId = 'unknown'): void {
    this.emit({ type: 'authentication-failed', ownerId, requestId, reason: 'unauthorized' })
  }

  acquireRequest(ownerId: string, requestId?: string): OwnerLease {
    const { id, state } = this.stateFor(ownerId)
    if (state.concurrentRequests >= this.quota.maxConcurrentRequests) {
      this.emit({ type: 'request-rejected', ownerId: id, requestId, reason: 'quota' })
      throw new OwnerQuotaError('requests', 'owner 请求并发额度已达上限')
    }
    state.concurrentRequests += 1
    this.emit({ type: 'request-accepted', ownerId: id, requestId })
    return this.lease(() => {
      state.concurrentRequests -= 1
    })
  }

  reserveConnection(ownerId: string, amount = 1): OwnerLease {
    const units = nonNegativeAmount(amount, 'connection amount')
    const { id, state } = this.stateFor(ownerId)
    if (state.connections + units > this.quota.maxConnections) {
      throw new OwnerQuotaError('connections', 'owner 连接额度已达上限')
    }
    state.connections += units
    this.emit({ type: 'connection-reserved', ownerId: id, amount: units })
    return this.lease(() => {
      state.connections -= units
      this.emit({ type: 'connection-released', ownerId: id, amount: units })
    })
  }

  reserveStorage(ownerId: string, bytes: number): OwnerLease {
    const amount = nonNegativeAmount(bytes, 'storage bytes')
    const { id, state } = this.stateFor(ownerId)
    if (state.storageBytes + amount > this.quota.maxStorageBytes) {
      throw new OwnerQuotaError('storage', 'owner 存储额度已达上限')
    }
    state.storageBytes += amount
    this.emit({ type: 'storage-reserved', ownerId: id, amount })
    return this.lease(() => {
      state.storageBytes -= amount
      this.emit({ type: 'storage-released', ownerId: id, amount })
    })
  }

  disposeOwner(ownerId: string): void {
    const id = normalizeOwnerId(ownerId)
    if (this.states.delete(id)) this.emit({ type: 'owner-disposed', ownerId: id })
  }

  dispose(): void {
    if (this.disposed) return
    for (const ownerId of this.states.keys()) this.emit({ type: 'owner-disposed', ownerId })
    this.states.clear()
    this.disposed = true
  }

  private lease(release: () => void): OwnerLease {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        release()
      }
    }
  }
}
