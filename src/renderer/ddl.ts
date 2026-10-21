/**
 * DDL 的界面层：建表对话框、建视图对话框、危险操作的确认与错误提示。
 *
 * ============================================================================
 * 责任边界（**先读这段再改代码**）
 * ============================================================================
 *
 * 本文件里的校验（列名非空 / 至少一列 / 列名不重复）**只是体验优化**，
 * 因为它跑在渲染进程、跑在用户自己的机器上——任何在校验之后被改动的输入
 * （DevTools、被注入的脚本、直接调 IPC）都会完全绕过它们。
 *
 * 真正的安全边界在**适配器层**（`src/drivers/sqlite/ddl.ts`）：
 *   - 标识符转义：`quoteIdentifier` 把名字里的 `"` 翻倍，名字再离谱也只是名字；
 *   - 类型白名单：`typeName` 只有命中白名单才放行，堵死
 *     `TEXT); DROP TABLE users;--` 这类把类型名当语句入口的攻击；
 *   - 默认值白名单：`defaultValue` 只接受字面量（数字 / 单引号字符串 / NULL …
 *     ），不接受任意表达式；
 *   - 其它不变量：自增只能用于 INTEGER 主键、列名按库的大小写规则去重等。
 *
 * 为什么 DDL 不能像 DML 那样靠参数化解决：DDL 的结构部分（表名/列名/类型/默认值）
 * 是 SQL 语法本身，占位符在这里是语法错误。所以只能靠白名单。
 * 该结论在 `src/drivers/sqlite/ddl.ts` 文件头有完整论证，与那里保持一致。
 *
 * 一句话：**前端校验拦「手滑」，后端校验拦「攻击」。两层都要有，不能互相替代。**
 *
 * ============================================================================
 * 为什么不 import 具体的 TableCreateSpec 实现细节
 * ============================================================================
 * `TableCreateSpec` 的定义位置曾一度漂移（`drivers/sqlite/ddl-types.ts` 临时定义，
 * 随后由 core 收编）。本文件只依赖 `../core/model` 这一个来源；
 * 若日后它再迁移，只需改这一处 import。
 */

import type { DbStudioApi } from '../core/api'
import type { ColumnCreateSpec, TableCreateSpec } from '../core/model'

// ============================================================================
// DDL 可用的 API 子集
// ============================================================================

/**
 * 我们需要的 DDL 能力。
 *
 * 为什么单独声明一个窄接口，而不是直接用 `DbStudioApi`：
 * DDL 的五个方法（createTable / dropTable / createView / dropView / renameTable）
 * 由另一条任务线（task-27）往 `DbStudioApi` 上补。若这里直接写
 * `api.createTable(...)`，在 core 还没落地时会整体编译失败——连带 `tree.ts`
 * 一起红掉，阻塞别人。窄接口让本文件**只要求「有这个能力」**，
 * core 补齐后 `DbStudioApi` 自然满足它，无需改本文件。
 *
 * `error` 用 unknown：DDL 失败可能是主进程抛的 IPC 错误对象，形状不定，
 * 我们只负责把它变成人话，见 `errorText`。
 */
export interface DdlApi {
  createTable(connectionId: string, spec: TableCreateSpec): Promise<void>
  /**
   * 删表。参数是**节点 id**（形如 `connection:c1|table:users`），
   * 不是裸表名——与 `core/api.ts` 的既有约定一致：连接归属随节点 id 一起传，
   * 避免"表名碰巧同名、删错连接"的歧义。
   */
  dropTable(nodeId: string): Promise<void>
  createView(connectionId: string, viewName: string, selectSql: string): Promise<void>
  /** 删视图。同样是**节点 id**（`connection:c1|view:v`）。 */
  dropView(nodeId: string): Promise<void>
  /** 重命名表。同样是**节点 id**。 */
  renameTable(nodeId: string, newName: string): Promise<void>
}

/**
 * 把 `window.dbstudio`（或调用方传入的 API）安全地转成 `DdlApi`。
 *
 * 为什么不在编译期强转：core 还没声明这些方法，强转只是骗过编译器；
 * 运行时若方法不存在，应当**明确报错**（而不是调用 undefined 抛 TypeError）。
 * 因此逐个检查方法是否存在——缺了就抛一个用户能看懂的错误。
 */
export function asDdlApi(api: unknown): DdlApi {
  if (!api || typeof api !== 'object') {
    throw new Error('DDL 不可用：缺少 dbstudio API（请通过 Electron 启动）。')
  }
  const required = [
    'createTable',
    'dropTable',
    'createView',
    'dropView',
    'renameTable'
  ] as const
  const record = api as Record<string, unknown>
  const missing = required.filter((m) => typeof record[m] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `DDL 不可用：当前版本缺少 ${missing.join(' / ')}。` +
        '这通常是主进程/预加载层尚未接入 DDL，请升级后再试。'
    )
  }
  return api as DdlApi
}

// ============================================================================
// 通用 UI 小工具
// ============================================================================

/**
 * 显式错误提示（模态）。
 *
 * 为什么不用状态栏：状态栏会被后续消息覆盖。DDL 失败是**必须让用户看见**的事，
 * 尤其是「表没建成」这种——用户如果没看到错误，会以为建好了，转头去查一张
 * 不存在的表。所以用 `alert()`：它会阻塞并强制用户确认，且不需要动 index.html
 * 或 style.css（自己没有弹窗组件的独占权）。
 *
 * 若将来项目有了统一的 toast/modal 组件，替换这一个函数即可。
 */
export function showDdlError(title: string, err: unknown): void {
  const detail = errorText(err)
  // 控制台留全量（含堆栈意图），弹窗只给人看的核心信息。
  console.error(`[DDL] ${title}`, err)
  // eslint-disable-next-line no-alert -- 见上方注释：此处刻意用阻塞式提示
  alert(`${title}\n\n${detail}`)
}

/** 从任意错误形状里抽出可读文本。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  // 主进程经 IPC 抛出的错误有时是普通对象 `{ message }`。
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** 危险操作的二次确认。文案必须带上对象名——只说「确定删除吗」等于没提示。 */
export function confirmDanger(message: string): boolean {
  // eslint-disable-next-line no-alert -- 危险操作必须阻塞确认
  return window.confirm(message)
}

/**
 * 创建一个模态遮罩 + 面板。
 *
 * 为什么手写而不复用 index.html 的 `<dialog>`：index.html 不在本工作流写入范围内，
 * 且建表/建视图对话框结构差异大，用 JS 构建更直接。遮罩挡住底层交互，
 * Esc 关闭，焦点初始落在第一个输入框。
 */
interface ModalHandle {
  readonly body: HTMLElement
  close(): void
  setBusy(busy: boolean): void
}

function createModal(title: string, opts: { width?: number } = {}): ModalHandle {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', title)
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
    'justify-content:center;background:rgba(0,0,0,.45);'

  const panel = document.createElement('div')
  panel.style.cssText =
    `width:${opts.width ?? 520}px;max-width:calc(100vw - 32px);` +
    'max-height:calc(100vh - 64px);display:flex;flex-direction:column;' +
    'background:var(--bg);color:var(--fg);border:1px solid var(--border);' +
    'border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px;'

  const head = document.createElement('div')
  head.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;' +
    'padding:10px 14px;border-bottom:1px solid var(--border);font-weight:600;'
  const titleEl = document.createElement('span')
  titleEl.textContent = title
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '✕'
  closeBtn.setAttribute('aria-label', '关闭')
  closeBtn.style.cssText = 'padding:0 6px;line-height:1.4;'
  head.appendChild(titleEl)
  head.appendChild(closeBtn)

  const body = document.createElement('div')
  body.style.cssText = 'padding:12px 14px;overflow:auto;'

  panel.appendChild(head)
  panel.appendChild(body)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  let busy = false
  const close = (): void => {
    // 提交中不许关：否则请求还在飞、用户已经点了关窗，结果无从得知。
    if (busy) return
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  document.addEventListener('keydown', onKey, true)
  closeBtn.addEventListener('click', close)
  // 点遮罩空白处关闭（点面板内不关）。
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close()
  })

  return {
    body,
    close,
    setBusy(next: boolean): void {
      busy = next
      closeBtn.disabled = next
    }
  }
}

// ============================================================================
// 建表对话框
// ============================================================================

/** 无参数类型白名单（与适配器白名单保持一致的子集；真正的放行判定在适配器）。 */
const SIMPLE_TYPES = [
  'INTEGER',
  'BIGINT',
  'REAL',
  'DOUBLE',
  'TEXT',
  'BLOB',
  'BOOLEAN',
  'DATE',
  'DATETIME',
  'TIMESTAMP',
  'JSON'
] as const

/**
 * 带参数类型。
 *
 * 重要：这里的下拉**不是自由输入**——用户不能手打类型名，只能从白名单选，
 * 参数（n / p,s）走独立的数字输入框。这样即便前端校验被绕过，
 * 送进适配器的 `typeName` 也只会是「白名单类型 + 数字参数」的组合形态，
 * 适配器再做一次白名单归一化，双重收口。
 */
type ParamKind = 'none' | 'length' | 'precision'

interface TypeOption {
  readonly label: string
  readonly base: string
  readonly param: ParamKind
}

const TYPE_OPTIONS: readonly TypeOption[] = [
  ...SIMPLE_TYPES.map((t) => ({ label: t, base: t, param: 'none' as const })),
  { label: 'VARCHAR(n)', base: 'VARCHAR', param: 'length' },
  { label: 'CHAR(n)', base: 'CHAR', param: 'length' },
  { label: 'NUMERIC(p,s)', base: 'NUMERIC', param: 'precision' },
  { label: 'DECIMAL(p,s)', base: 'DECIMAL', param: 'precision' }
]

/** 一列在编辑器里的临时状态。 */
interface ColumnRowState {
  name: string
  typeIndex: number
  lengthOrPrecision: string
  scale: string
  notNull: boolean
  primaryKey: boolean
  autoIncrement: boolean
  defaultValue: string
}

function emptyColumnRow(isFirst: boolean): ColumnRowState {
  return {
    name: '',
    typeIndex: SIMPLE_TYPES.indexOf('TEXT'),
    lengthOrPrecision: '',
    scale: '',
    notNull: false,
    // 首列默认主键，符合大多数人建表的直觉；用户可改。
    primaryKey: isFirst,
    autoIncrement: false,
    defaultValue: ''
  }
}

/** 由编辑器行状态拼出 `typeName`（未做白名单校验，交给适配器最终把关）。 */
function buildTypeName(row: ColumnRowState): string {
  const opt = TYPE_OPTIONS[row.typeIndex]
  if (!opt) return 'TEXT'
  if (opt.param === 'none') return opt.base
  const n = row.lengthOrPrecision.trim()
  if (opt.param === 'length') return `${opt.base}(${n})`
  const s = row.scale.trim()
  return `${opt.base}(${n}${s ? `,${s}` : ''})`
}

/**
 * 建表对话框。
 *
 * @param api 具备 DDL 能力的 API（调用方用 `asDdlApi(window.dbstudio)` 得到）
 * @param connectionId 目标连接 id（裸 id，不含 `connection:` 前缀）
 * @param onDone 成功后回调，通常用于刷新「表」分组
 */
export function openCreateTableDialog(
  api: DdlApi,
  connectionId: string,
  onDone: () => void
): void {
  const modal = createModal('新建表')
  const rows: ColumnRowState[] = [emptyColumnRow(true)]

  // --- 表名 ---
  const nameField = document.createElement('label')
  nameField.style.cssText = 'display:block;margin-bottom:10px;'
  const nameLabel = document.createElement('div')
  nameLabel.textContent = '表名'
  nameLabel.style.cssText = 'margin-bottom:4px;color:var(--fg-dim);'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.placeholder = '例如：customers'
  nameInput.setAttribute('aria-label', '表名')
  nameInput.style.cssText = inputStyle()
  nameField.appendChild(nameLabel)
  nameField.appendChild(nameInput)

  // --- 列编辑区 ---
  const colsTitle = document.createElement('div')
  colsTitle.textContent = '列'
  colsTitle.style.cssText = 'margin:6px 0;color:var(--fg-dim);'

  const colsHost = document.createElement('div')
  colsHost.style.cssText = 'display:flex;flex-direction:column;gap:6px;'

  const addColBtn = document.createElement('button')
  addColBtn.type = 'button'
  addColBtn.textContent = '＋ 添加列'
  addColBtn.style.cssText = 'margin-top:8px;align-self:flex-start;'

  // 前端校验错误展示（不替代适配器的安全校验）。
  const hint = document.createElement('p')
  hint.setAttribute('role', 'alert')
  hint.style.cssText = 'margin:10px 0 0;color:var(--danger);font-size:12px;min-height:1.2em;'

  // --- 底部按钮 ---
  const footer = document.createElement('div')
  footer.style.cssText =
    'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  const submitBtn = document.createElement('button')
  submitBtn.type = 'button'
  submitBtn.textContent = '创建'
  footer.appendChild(cancelBtn)
  footer.appendChild(submitBtn)

  modal.body.appendChild(nameField)
  modal.body.appendChild(colsTitle)
  modal.body.appendChild(colsHost)
  modal.body.appendChild(addColBtn)
  modal.body.appendChild(hint)
  modal.body.appendChild(footer)

  // ---- 行渲染 ----
  const renderRows = (): void => {
    colsHost.replaceChildren()
    rows.forEach((row, idx) => {
      colsHost.appendChild(renderColumnRow(row, idx, rows, renderRows))
    })
  }

  addColBtn.addEventListener('click', () => {
    rows.push(emptyColumnRow(false))
    renderRows()
  })
  cancelBtn.addEventListener('click', () => modal.close())

  // ---- 提交 ----
  submitBtn.addEventListener('click', () => {
    const validation = validateTable(nameInput.value, rows)
    if (!validation.ok) {
      // 前端校验失败就地提示，不弹窗（用户正在编辑，弹窗打断感太强）。
      hint.textContent = validation.message
      return
    }
    hint.textContent = ''
    const spec: TableCreateSpec = {
      name: validation.specName,
      columns: validation.columns
    }
    submitBtn.disabled = true
    submitBtn.textContent = '创建中…'
    modal.setBusy(true)
    void (async () => {
      try {
        await api.createTable(connectionId, spec)
        modal.setBusy(false)
        modal.close()
        onDone()
      } catch (e) {
        // DDL 失败必须弹显式提示（状态栏会被冲掉）。窗口保持打开，用户可改后重试。
        showDdlError(`创建表「${spec.name}」失败`, e)
        submitBtn.disabled = false
        submitBtn.textContent = '创建'
        modal.setBusy(false)
      }
    })()
  })

  renderRows()
  nameInput.focus()
}

/** 渲染一列的三行小编辑器（名称+类型 / 选项 / 默认值）。 */
function renderColumnRow(
  row: ColumnRowState,
  idx: number,
  rows: ColumnRowState[],
  rerender: () => void
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.style.cssText =
    'border:1px solid var(--border);border-radius:6px;padding:8px;' +
    'display:flex;flex-direction:column;gap:6px;'

  // 第 1 行：列名 + 类型下拉 + 参数 + 删除
  const line1 = document.createElement('div')
  line1.style.cssText = 'display:flex;gap:6px;align-items:center;'

  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.placeholder = '列名'
  nameInput.value = row.name
  nameInput.setAttribute('aria-label', `第 ${idx + 1} 列的列名`)
  nameInput.style.cssText = inputStyle() + 'flex:1 1 120px;'
  nameInput.addEventListener('input', () => {
    row.name = nameInput.value
  })

  const typeSelect = document.createElement('select')
  typeSelect.setAttribute('aria-label', `第 ${idx + 1} 列的类型`)
  typeSelect.style.cssText = inputStyle() + 'flex:0 0 130px;'
  TYPE_OPTIONS.forEach((opt, i) => {
    const o = document.createElement('option')
    o.value = String(i)
    o.textContent = opt.label
    if (i === row.typeIndex) o.selected = true
    typeSelect.appendChild(o)
  })

  line1.appendChild(nameInput)
  line1.appendChild(typeSelect)

  // 参数输入（仅 VARCHAR/CHAR/NUMERIC/DECIMAL 显示）
  const opt = TYPE_OPTIONS[row.typeIndex]
  if (opt && opt.param !== 'none') {
    const p = document.createElement('input')
    p.type = 'number'
    p.min = '1'
    p.placeholder = opt.param === 'length' ? 'n' : 'p'
    p.value = row.lengthOrPrecision
    p.setAttribute('aria-label', `第 ${idx + 1} 列的长度/精度`)
    p.style.cssText = inputStyle() + 'flex:0 0 70px;'
    p.addEventListener('input', () => {
      row.lengthOrPrecision = p.value
    })
    line1.appendChild(p)
    if (opt.param === 'precision') {
      const s = document.createElement('input')
      s.type = 'number'
      s.min = '0'
      s.placeholder = 's'
      s.value = row.scale
      s.setAttribute('aria-label', `第 ${idx + 1} 列的小数位`)
      s.style.cssText = inputStyle() + 'flex:0 0 60px;'
      s.addEventListener('input', () => {
        row.scale = s.value
      })
      line1.appendChild(s)
    }
  }

  typeSelect.addEventListener('change', () => {
    row.typeIndex = Number(typeSelect.value)
    // 类型变了要重绘，因为参数输入框的有无/含义随之变化。
    rerender()
  })

  const delBtn = document.createElement('button')
  delBtn.type = 'button'
  delBtn.textContent = '删除'
  delBtn.setAttribute('aria-label', `删除第 ${idx + 1} 列`)
  delBtn.style.cssText = 'flex:0 0 auto;'
  delBtn.addEventListener('click', () => {
    // 至少保留一列：删到 0 列没有意义，且会让「至少一列」校验形同虚设。
    if (rows.length <= 1) return
    rows.splice(idx, 1)
    rerender()
  })
  line1.appendChild(delBtn)

  // 第 2 行：约束勾选
  const line2 = document.createElement('div')
  line2.style.cssText = 'display:flex;gap:14px;align-items:center;color:var(--fg-dim);'
  line2.appendChild(
    checkbox('NOT NULL', row.notNull, (v) => {
      row.notNull = v
    })
  )
  line2.appendChild(
    checkbox('主键', row.primaryKey, (v) => {
      row.primaryKey = v
      // 主键与自增耦合：勾掉主键时自增也失去意义，顺手取消，避免送出一个
      // 必然被适配器拒绝的组合（自增必须挂在 INTEGER 主键上）。
      if (!v) {
        row.autoIncrement = false
        rerender()
      }
    })
  )
  line2.appendChild(
    checkbox('自增', row.autoIncrement, (v) => {
      row.autoIncrement = v
      // 勾自增时自动勾主键：这是 SQLite 的硬性要求，前端先帮用户对齐，
      // 真正的拦截仍在适配器（非 INTEGER 时会明确报错）。
      if (v) {
        row.primaryKey = true
        rerender()
      }
    })
  )

  // 第 3 行：默认值
  const line3 = document.createElement('div')
  line3.style.cssText = 'display:flex;gap:6px;align-items:center;'
  const defLabel = document.createElement('span')
  defLabel.textContent = '默认值'
  defLabel.style.cssText = 'flex:0 0 auto;color:var(--fg-dim);'
  const defInput = document.createElement('input')
  defInput.type = 'text'
  defInput.placeholder = '留空表示无默认值，如 0 / NULL / ' + "'abc'"
  defInput.value = row.defaultValue
  defInput.setAttribute('aria-label', `第 ${idx + 1} 列的默认值`)
  defInput.style.cssText = inputStyle() + 'flex:1 1 auto;'
  defInput.addEventListener('input', () => {
    row.defaultValue = defInput.value
  })
  line3.appendChild(defLabel)
  line3.appendChild(defInput)

  wrap.appendChild(line1)
  wrap.appendChild(line2)
  wrap.appendChild(line3)
  return wrap
}

function checkbox(
  label: string,
  checked: boolean,
  onChange: (v: boolean) => void
): HTMLElement {
  const l = document.createElement('label')
  l.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;'
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = checked
  box.addEventListener('change', () => onChange(box.checked))
  const span = document.createElement('span')
  span.textContent = label
  l.appendChild(box)
  l.appendChild(span)
  return l
}

function inputStyle(): string {
  return (
    'font:inherit;font-size:12px;padding:4px 6px;box-sizing:border-box;' +
    'border:1px solid var(--border);border-radius:4px;' +
    'background:var(--bg);color:var(--fg);'
  )
}

/** 校验结果：要么给出整理好的 spec，要么给出人话错误。 */
type ValidationResult =
  | { ok: true; specName: string; columns: ColumnCreateSpec[] }
  | { ok: false; message: string }

/**
 * 前端校验（**只是体验**，安全以适配器为准，见文件头）。
 *
 * 覆盖三件事，正好对应任务要求：
 *   1. 表名非空
 *   2. 至少一列
 *   3. 列名非空、列名不重复（不区分大小写——SQLite 列名即不区分大小写）
 * 另外顺手把「带参数类型必须填参数」也挡掉，避免给用户一个必然失败的提交。
 */
export function validateTable(
  rawName: string,
  rows: readonly ColumnRowState[]
): ValidationResult {
  const name = rawName.trim()
  if (name === '') return { ok: false, message: '表名不能为空。' }
  if (rows.length === 0) return { ok: false, message: '至少需要定义一列。' }

  const seen = new Set<string>()
  const columns: ColumnCreateSpec[] = []
  const pkRows = rows.filter((r) => r.primaryKey)
  // 主键序号：按勾选顺序分配（多列主键时适配器据此排序）。
  let pkOrdinal = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row) continue
    const colName = row.name.trim()
    const where = `第 ${i + 1} 列`
    if (colName === '') {
      return { ok: false, message: `${where}：列名不能为空。` }
    }
    const lower = colName.toLowerCase()
    if (seen.has(lower)) {
      return { ok: false, message: `${where}：列名重复「${colName}」（列名不区分大小写）。` }
    }
    seen.add(lower)

    const opt = TYPE_OPTIONS[row.typeIndex]
    if (!opt) return { ok: false, message: `${where}：请选择类型。` }
    // 带参数类型必须给出正整数参数（前端拦，适配器仍会再校验）。
    if (opt.param === 'length' && !/^\d+$/.test(row.lengthOrPrecision.trim())) {
      return { ok: false, message: `${where}：${opt.base} 需要填写长度（正整数）。` }
    }
    if (opt.param === 'precision' && !/^\d+$/.test(row.lengthOrPrecision.trim())) {
      return { ok: false, message: `${where}：${opt.base} 需要填写精度（正整数）。` }
    }

    // 自增只能用于 INTEGER 主键——前端先提示，避免一次注定失败的提交。
    if (row.autoIncrement && (!row.primaryKey || opt.base !== 'INTEGER')) {
      return {
        ok: false,
        message: `${where}：自增只能用于 INTEGER 类型的主键。`
      }
    }

    const col: {
      name: string
      typeName: string
      nullable?: boolean
      primaryKeyOrdinal?: number
      defaultValue?: string
    } = {
      name: colName,
      typeName: buildTypeName(row),
      nullable: !row.notNull
    }
    if (row.primaryKey) {
      pkOrdinal += 1
      col.primaryKeyOrdinal = pkOrdinal
    }
    const def = row.defaultValue.trim()
    if (def !== '') col.defaultValue = def
    columns.push(col)
  }

  if (pkRows.length === 0) {
    // 不强制主键（很多表确实没有），不报错；仅留注释说明这是有意为之。
  }
  return { ok: true, specName: name, columns }
}

// ============================================================================
// 新建视图对话框
// ============================================================================

/**
 * 新建视图对话框。
 *
 * 只做「视图名 + SELECT 语句」两件事。给一句「只允许 SELECT 查询」的提示，
 * 但**不**在前端解析 SQL 来判断它是不是 SELECT——那需要真正的 SQL 解析器，
 * 且前端判断一样可被绕过。是否真的只允许 SELECT，由适配器/数据库强制。
 */
export function openCreateViewDialog(
  api: DdlApi,
  connectionId: string,
  onDone: () => void
): void {
  const modal = createModal('新建视图')
  const rows: ColumnRowState[] = [] // 复用类型：视图不需要列编辑器，仅保持签名一致

  const nameField = document.createElement('label')
  nameField.style.cssText = 'display:block;margin-bottom:10px;'
  const nameLabel = document.createElement('div')
  nameLabel.textContent = '视图名'
  nameLabel.style.cssText = 'margin-bottom:4px;color:var(--fg-dim);'
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.placeholder = '例如：v_active_users'
  nameInput.setAttribute('aria-label', '视图名')
  nameInput.style.cssText = inputStyle()
  nameField.appendChild(nameLabel)
  nameField.appendChild(nameInput)

  const sqlLabel = document.createElement('div')
  sqlLabel.textContent = 'SELECT 语句'
  sqlLabel.style.cssText = 'margin-bottom:4px;color:var(--fg-dim);'
  const sqlInput = document.createElement('textarea')
  sqlInput.rows = 8
  sqlInput.placeholder = 'SELECT ... FROM ...'
  sqlInput.setAttribute('aria-label', '视图的 SELECT 语句')
  sqlInput.style.cssText = inputStyle() + 'width:100%;resize:vertical;min-height:120px;font-family:var(--mono);'

  const notice = document.createElement('p')
  notice.textContent = '提示：视图只能基于 SELECT 查询（具体限制由数据库强制）。'
  notice.style.cssText = 'margin:8px 0 0;color:var(--fg-dim);font-size:12px;'

  const hint = document.createElement('p')
  hint.setAttribute('role', 'alert')
  hint.style.cssText = 'margin:8px 0 0;color:var(--danger);font-size:12px;min-height:1.2em;'

  const footer = document.createElement('div')
  footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  const submitBtn = document.createElement('button')
  submitBtn.type = 'button'
  submitBtn.textContent = '创建'
  footer.appendChild(cancelBtn)
  footer.appendChild(submitBtn)

  modal.body.appendChild(nameField)
  modal.body.appendChild(sqlLabel)
  modal.body.appendChild(sqlInput)
  modal.body.appendChild(notice)
  modal.body.appendChild(hint)
  modal.body.appendChild(footer)

  cancelBtn.addEventListener('click', () => modal.close())

  submitBtn.addEventListener('click', () => {
    const viewName = nameInput.value.trim()
    const sql = sqlInput.value.trim()
    // 前端只做最基本的「非空」提示；SQL 合法性交给后端。
    if (viewName === '') {
      hint.textContent = '视图名不能为空。'
      return
    }
    if (sql === '') {
      hint.textContent = 'SELECT 语句不能为空。'
      return
    }
    hint.textContent = ''
    submitBtn.disabled = true
    submitBtn.textContent = '创建中…'
    modal.setBusy(true)
    void (async () => {
      try {
        await api.createView(connectionId, viewName, sql)
        modal.setBusy(false)
        modal.close()
        onDone()
      } catch (e) {
        showDdlError(`创建视图「${viewName}」失败`, e)
        submitBtn.disabled = false
        submitBtn.textContent = '创建'
        modal.setBusy(false)
      }
    })()
  })

  // rows 未被使用（视图无列编辑器），显式 void 掉以免 lint 抱怨未使用变量。
  void rows
  nameInput.focus()
}

// ============================================================================
// 重命名表对话框
// ============================================================================

/**
 * 重命名表：单输入框。成功后回调刷新。
 *
 * @param nodeId 表节点 id（`connection:c1|table:users`）——与 `api.renameTable` 对齐。
 * @param currentName 当前表名，仅用于回填输入框与错误文案。
 */
export function openRenameTableDialog(
  api: DdlApi,
  nodeId: string,
  currentName: string,
  onDone: () => void
): void {
  const modal = createModal('重命名表', { width: 380 })
  const field = document.createElement('label')
  field.style.cssText = 'display:block;'
  const label = document.createElement('div')
  label.textContent = `原表名：${currentName}`
  label.style.cssText = 'margin-bottom:6px;color:var(--fg-dim);'
  const input = document.createElement('input')
  input.type = 'text'
  input.value = currentName
  input.setAttribute('aria-label', '新表名')
  input.style.cssText = inputStyle() + 'width:100%;'
  field.appendChild(label)
  field.appendChild(input)

  const hint = document.createElement('p')
  hint.setAttribute('role', 'alert')
  hint.style.cssText = 'margin:8px 0 0;color:var(--danger);font-size:12px;min-height:1.2em;'

  const footer = document.createElement('div')
  footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.textContent = '取消'
  const submitBtn = document.createElement('button')
  submitBtn.type = 'button'
  submitBtn.textContent = '重命名'
  footer.appendChild(cancelBtn)
  footer.appendChild(submitBtn)

  modal.body.appendChild(field)
  modal.body.appendChild(hint)
  modal.body.appendChild(footer)
  cancelBtn.addEventListener('click', () => modal.close())

  submitBtn.addEventListener('click', () => {
    const next = input.value.trim()
    if (next === '') {
      hint.textContent = '新表名不能为空。'
      return
    }
    if (next === currentName) {
      hint.textContent = '新表名与原表名相同。'
      return
    }
    hint.textContent = ''
    submitBtn.disabled = true
    submitBtn.textContent = '处理中…'
    modal.setBusy(true)
    void (async () => {
      try {
        await api.renameTable(nodeId, next)
        modal.setBusy(false)
        modal.close()
        onDone()
      } catch (e) {
        showDdlError(`重命名表「${currentName}」→「${next}」失败`, e)
        submitBtn.disabled = false
        submitBtn.textContent = '重命名'
        modal.setBusy(false)
      }
    })()
  })

  input.focus()
  input.select()
}

// ============================================================================
// 删除（表 / 视图）
// ============================================================================

/**
 * 删除表。**二次确认，且确认文案必须含表名。**
 *
 * 为什么文案要带名字：删错一张表的代价极高，而「确定删除吗？」不提供任何
 * 核对信息——用户点右键时可能选中的是相邻一行。把名字写进确认框，
 * 用户扫一眼就能发现「不对，我要删的不是这个」。
 *
 * @param nodeId 表节点 id（`connection:c1|table:users`），与 `api.dropTable` 对齐。
 * @param tableName 仅用于确认文案与错误提示——**不**参与 API 调用。
 * 返回是否成功（供调用方决定要不要刷新）。
 */
export async function dropTableWithConfirm(
  api: DdlApi,
  nodeId: string,
  tableName: string
): Promise<boolean> {
  const ok = confirmDanger(
    `确定删除表「${tableName}」吗？\n\n` +
      '这个操作会删除表结构与其中的全部数据，且通常无法撤销。'
  )
  if (!ok) return false
  try {
    await api.dropTable(nodeId)
    return true
  } catch (e) {
    showDdlError(`删除表「${tableName}」失败`, e)
    return false
  }
}

/**
 * 删除视图。同样二次确认并写出视图名。
 *
 * @param nodeId 视图节点 id（`connection:c1|view:v`），与 `api.dropView` 对齐。
 * @param viewName 仅用于文案，不参与 API 调用。
 */
export async function dropViewWithConfirm(
  api: DdlApi,
  nodeId: string,
  viewName: string
): Promise<boolean> {
  const ok = confirmDanger(
    `确定删除视图「${viewName}」吗？\n\n` +
      '这个操作只删除视图定义，不会删除底层表的数据。'
  )
  if (!ok) return false
  try {
    await api.dropView(nodeId)
    return true
  } catch (e) {
    showDdlError(`删除视图「${viewName}」失败`, e)
    return false
  }
}
