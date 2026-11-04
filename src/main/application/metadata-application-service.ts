/**
 * 元数据用例服务：树节点展开、表结构描述与结构快照。
 *
 * ===== 为什么从 ConnectionManager 里抽出来 =====
 *
 * `listChildren` / `describeTable` / `captureSchemaSnapshot` 是一组只读的
 * 元数据用例：它们只做「把节点 id 解析成活动会话，再让宿主进程读元数据」，
 * 不碰持久化配置、不碰会话生命周期、不碰导入/导出任务编排。
 *
 * 其中 `captureSchemaSnapshot` 又天然依赖前两个方法（逐层展开、逐表 describe），
 * 三者放在一起才能让「遍历深度、schema 过滤、失败降级」这些规则只写一次。
 * `ConnectionManager` 因此只剩兼容 facade 的转发职责。
 *
 * ===== 边界 =====
 *
 * 本模块**不** import `ConnectionManager`、electron、`src/drivers` 或任何具体
 * adapter。它只认识：
 *
 *   - `ConnectionResolver`：节点 id → 活动会话（错误文案的唯一出口）；
 *   - `getSession`：会话身份查询（根节点展开与快照遍历都要用）；
 *   - `listConnections`：根层节点来自目录投影，而不是 adapter；
 *   - core 的 `NodeId`：作用域 id 的编解码规则（纯数据，无运行时驱动依赖）。
 *
 * `LiveConnection.host` 只以类型出现（经 `types.ts` 的 `import type`），
 * 因此本模块没有任何运行时依赖会顺着宿主句柄进入 driver-host 之外的地方。
 *
 * ===== 必须保持的契约 =====
 *
 * 1. **根节点 meta**：`dialect` / `connected` / `persisted` / `secretStored`
 *    以及拍平的 `options.<key>` 与 `inlineEdit`。漏字段会让 UI 永远显示「未保存」。
 * 2. **子节点重写**：`id` 必须包上连接作用域，`parentId` 必须是当前这一层的
 *    作用域 id，否则 UI 建树会接错。
 * 3. **错误文案**：`无法解析的节点 id` / `连接不存在或已断开` /
 *    「连接节点没有表结构…」逐字保留。
 * 4. **快照遍历**：只下钻 schema / folder / catalog，深度上限 4；
 *    schema 过滤只作用于 schema 节点；表按 schema+name 排序。
 * 5. **失败降级**：`viewDefinition` / `listRoutines` 单次失败不拖垮整次快照，
 *    分别退化为 `definition: null` 与空例程列表。
 * 6. **SQL 方言守卫**：只允许 sqlite / postgresql / mysql 生成结构快照，
 *    浏览型数据源（Redis / Kafka）必须拒绝，避免生成「删光目标端」的 DROP 计划。
 */

import { NodeId, type ConnectionSummary } from '../../core/api'
import type { RoutineDefinition, SchemaSnapshot, SnapshotTable } from '../../core/compare'
import type { ObjectRef, TableDescription } from '../../core/model'
import type { ConnectionResolver } from './connection-resolver'
import type { LiveConnection } from './types'

/**
 * 元数据用例服务的外部依赖。
 *
 * 全部是最小能力注入，而不是让服务反向持有 ConnectionManager：
 *   - `resolver` 负责节点 id → 会话与统一错误文案；
 *   - `getSession` 用于根层展开与快照遍历时读取活动会话；
 *   - `listConnections` 只提供根层需要的摘要投影（目录负责，服务不碰存储）。
 */
export interface MetadataApplicationContext {
  readonly resolver: ConnectionResolver
  /** 读取当前活动会话；没有（未连接 / 已断开 / 已替换）返回 undefined。 */
  readonly getSession: (connectionId: string) => LiveConnection | undefined
  /** 根层节点列表（已保存连接摘要）。由目录投影提供。 */
  readonly listConnections: () => ConnectionSummary[]
}

export class MetadataApplicationService {
  readonly #ctx: MetadataApplicationContext

  constructor(context: MetadataApplicationContext) {
    this.#ctx = context
  }

  /**
   * 列子节点。
   *
   * 三处细节，都是踩过坑才知道要处理的：
   *  1. 根层（null）返回的是「连接」本身，不是 adapter 的数据；
   *  2. 连接层（adapterId === null）要调 adapter 的 `listChildren(null)`；
   *  3. 子节点的 parentId 必须改写成本层的**作用域 id**，否则 UI 建树会接错。
   */
  async listChildren(nodeId: string | null): Promise<ObjectRef[]> {
    if (nodeId === null) {
      return this.#ctx.listConnections().map((c) => ({
        id: NodeId.connection(c.id),
        kind: 'connection' as const,
        name: c.name,
        parentId: null,
        hasChildren: true,
        meta: {
          dialect: c.dialectId,
          connected: c.connected,
          // ★ 这两个字段是 UI 显示状态所必需的，漏传会让 UI 永远显示「未保存」
          //   （`ref.meta?.['persisted'] === true` 永远为 false）。
          //   meta 的值域是 string|number|boolean|null，故 secretStored 的
          //   `boolean|null` 可直接放。null 表示「该方言不需要密码」，
          //   UI 应据此区分「无需密码」与「需要但没存上」。
          persisted: c.persisted,
          secretStored: c.secretStored,
          // 把配置参数拍平成 `options.<key>` 放进 meta，供「编辑连接」对话框回填。
          // 拍平而不是嵌套对象：ObjectRef.meta 的值域必须能结构化克隆。
          ...Object.fromEntries(
            Object.entries(c.options).map(([k, v]) => [`options.${k}`, v])
          ),
          ...(c.capabilities ? { inlineEdit: c.capabilities.supportsInlineEdit } : {})
        }
      }))
    }

    const parsed = NodeId.parse(nodeId)
    if (!parsed) throw new Error(`无法解析的节点 id: ${nodeId}`)

    const conn = this.#ctx.getSession(parsed.connectionId)
    if (!conn) throw new Error(`连接不存在或已断开: ${parsed.connectionId}`)

    const raw = await conn.host.listChildren(parsed.adapterId)
    const parentScoped = nodeId
    return raw.map((item) => ({
      ...item,
      id: NodeId.scoped(conn.id, item.id),
      parentId: parentScoped
    }))
  }

  describeTable(nodeId: string): Promise<TableDescription> {
    const parsed = NodeId.parse(nodeId)
    if (!parsed) return Promise.reject(new Error(`无法解析的节点 id: ${nodeId}`))
    if (parsed.adapterId === null) {
      return Promise.reject(new Error('连接节点没有表结构，请选择具体的表或视图'))
    }
    const conn = this.#ctx.getSession(parsed.connectionId)
    if (!conn) return Promise.reject(new Error(`连接不存在或已断开: ${parsed.connectionId}`))
    return conn.host.describeTable(parsed.adapterId)
  }

  /**
   * 只读结构快照。展开表和视图后逐个 describe，不执行任何同步 SQL。
   */
  async captureSchemaSnapshot(
    connectionId: string,
    schema?: string | null
  ): Promise<SchemaSnapshot> {
    const tables: SnapshotTable[] = []
    const views: { schema: string | null; name: string; definition: string | null }[] = []
    // 只下钻 folder / schema，表和视图是叶子（它们的子节点是列，不需要）。
    // 深度上限防止异常驱动返回环。
    const conn = this.#ctx.getSession(connectionId)
    if (!conn) throw new Error(`连接不存在或已断开: ${connectionId}`)
    // 只浏览数据源（Redis / Kafka）没有表结构。放它进来会得到一张空快照，
    // 再被拿去和目标库比较，就会生成「删除目标端全部表」的 DROP 计划。
    // 守卫必须在遍历之前：先报「不支持」，而不是先跑一遍空遍历。
    if (
      conn.config.dialectId !== 'sqlite' &&
      conn.config.dialectId !== 'postgresql' &&
      conn.config.dialectId !== 'mysql'
    ) {
      throw new Error(`${conn.info.name} 没有表结构，不能参与结构比较（只支持 SQL 数据源）`)
    }
    const walk = async (
      nodeId: string,
      currentSchema: string | null,
      depth: number
    ): Promise<void> => {
      if (depth > 4) return
      for (const node of await this.listChildren(nodeId)) {
        if (node.kind === 'schema') {
          if (schema && node.name !== schema) continue
          await walk(node.id, node.name, depth + 1)
        } else if (node.kind === 'folder' || node.kind === 'catalog') {
          await walk(node.id, currentSchema, depth + 1)
        } else if (node.kind === 'table') {
          tables.push({
            ...(await this.describeTable(node.id)),
            schema: currentSchema,
            name: node.name
          })
        } else if (node.kind === 'view') {
          /*
           * 读取视图的真实 DDL。没有这一步，快照里所有视图的 definition 都是
           * null，比较器只能判断「视图存在与否」，判断不出「定义改没改」——
           * 那会让用户以为结构一致，实际视图逻辑已经不同。
           *
           * 单条读取失败不拖垮整次快照：拿不到就留 null，上层会把它标成
           * 「定义未捕获」并告警（可见的不确定，好过静默的错误结论）。
           */
          let definition: string | null = null
          const viewAdapterId = NodeId.parse(node.id)?.adapterId ?? null
          if (viewAdapterId !== null) {
            try {
              definition = await conn.host.viewDefinition(viewAdapterId)
            } catch {
              definition = null
            }
          }
          views.push({ schema: currentSchema, name: node.name, definition })
        }
      }
    }
    await walk(NodeId.connection(connectionId), null, 0)
    const byName = (
      a: { schema: string | null; name: string },
      b: { schema: string | null; name: string }
    ) => `${a.schema ?? ''}.${a.name}`.localeCompare(`${b.schema ?? ''}.${b.name}`)
    tables.sort(byName)
    views.sort(byName)
    /*
     * 例程（函数 / 存储过程）。它们不在树节点里（树只展开表/视图），
     * 所以单独查一次。驱动不支持时 host 会返回空数组（见 driver-host 的
     * listRoutines 分支），SQLite 就是这种情况——它没有持久化例程。
     *
     * 同样按「失败不拖垮快照」处理：查不到就当没有例程，不抛错。
     */
    let routines: RoutineDefinition[] = []
    try {
      const raw = await conn.host.listRoutines({ schema: schema ?? null })
      routines = raw.map((routine) => ({
        schema: routine.schema,
        name: routine.name,
        kind: routine.kind,
        definition: routine.definition,
        // 签名原样透传给比较器：它是区分重载的唯一依据，不能在中间层丢掉。
        ...(routine.signature === undefined ? {} : { signature: routine.signature })
      }))
    } catch {
      routines = []
    }
    return {
      source: { connectionId, schema: schema ?? null },
      tables,
      views,
      routines
    }
  }
}
