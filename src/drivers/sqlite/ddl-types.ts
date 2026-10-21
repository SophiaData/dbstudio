/**
 * DDL 输入类型的**转发出口**。
 *
 * 这些类型已经由 host-e2e 落盘在 `src/core/model.ts`
 * （`ColumnCreateSpec` / `TableCreateSpec`）。这里只做 re-export，
 * 目的是让 `src/drivers/sqlite/*` 内部统一从本地模块引用，
 * 同时避免任何"另建一份定义"的可能——两份定义迟早会漂移。
 */

export type { ColumnCreateSpec, TableCreateSpec } from '../../core/model'
