/**
 * SDK 的版本化能力声明。
 *
 * 驱动契约会随能力增长而演进（新增方法、新增元数据字段、新增传输格式）。
 * 调用方需要一种"我拿到的是哪一版契约"的判断依据，而不是靠猜字段是否存在。
 * 所以这里显式公开五个版本号：
 *
 *   - `HANDSHAKE_PROTOCOL_VERSION` 宿主 ⇄ 客户端握手帧本身的版本
 *   - `DRIVER_API_VERSION`       驱动适配器接口 / RPC 方法集的版本
 *   - `METADATA_SCHEMA_VERSION`  元数据结构（ObjectRef / TableDescription 等）的版本
 *   - `TRANSFER_SCHEMA_VERSION`  传输契约（TransferSource / ImportBatch 等）的版本
 *   - `SDK_CONTRACT_VERSION`     以上各者的整体版本，供"整体兼容性"快速判断
 *
 * ===== 为什么这里只做 re-export，不再定义常量 =====
 *
 * 这些值必须与驱动宿主、主进程**完全一致**。先前它们在 SDK 里单独定义了一份，
 * 宿主发的是另一个自由格式的 `adapterVersion` 字符串——两边永远不会因为
 * 版本对不上而报错，问题只会在调用某个方法时以「字段是 undefined」的形式爆发。
 * 现在唯一的事实来源是 `src/core/driver.ts`，本文件只负责从 SDK 公开它们。
 *
 * 兼容策略（与 plan P6.1 一致）：**新字段一律用可选扩展**（`?:`），
 * 只有在做破坏性变更时才提升主版本号。调用方按 `SDK_CONTRACT_VERSION` 判断，
 * 细分差异按各自的 schema 版本判断；握手阶段两侧会严格校验这些数字，
 * 版本不一致时给出可诊断的错误，而不是静默降级。
 */

export {
  HANDSHAKE_PROTOCOL_VERSION,
  DRIVER_API_VERSION,
  METADATA_SCHEMA_VERSION,
  TRANSFER_SCHEMA_VERSION,
  SDK_CONTRACT_VERSION
} from './contracts/driver.js'
