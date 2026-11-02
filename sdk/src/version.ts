/**
 * SDK 的版本化能力声明。
 *
 * 驱动契约会随能力增长而演进（新增方法、新增元数据字段、新增传输格式）。
 * 调用方需要一种"我拿到的是哪一版契约"的判断依据，而不是靠猜字段是否存在。
 * 所以这里显式公开四个版本号：
 *
 *   - `DRIVER_API_VERSION`     驱动适配器接口 / RPC 方法集的版本
 *   - `METADATA_SCHEMA_VERSION` 元数据结构（ObjectRef / TableDescription 等）的版本
 *   - `TRANSFER_SCHEMA_VERSION` 传输契约（TransferSource / ImportBatch 等）的版本
 *   - `SDK_CONTRACT_VERSION`   以上三者的整体版本，供"整体兼容性"快速判断
 *
 * 兼容策略（与 plan P6.1 一致）：**新字段一律用可选扩展**（`?:`），
 * 只有在做破坏性变更时才提升主版本号。调用方按 `SDK_CONTRACT_VERSION` 判断，
 * 细分差异按各自的 schema 版本判断。
 */

export const DRIVER_API_VERSION = 1 as const
export const METADATA_SCHEMA_VERSION = 1 as const
export const TRANSFER_SCHEMA_VERSION = 1 as const
export const SDK_CONTRACT_VERSION = 1 as const
