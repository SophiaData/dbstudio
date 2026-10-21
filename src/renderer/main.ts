/**
 * 渲染进程入口：把树、详情面板、新建连接对话框接线起来。
 *
 * 这里刻意保持「薄」——所有数据都来自 `window.dbstudio`（preload 白名单），
 * 渲染进程自己**不知道** SQLite 长什么样，也不知道驱动跑在哪个进程。
 * 这条边界就是剖析报告里「model 层无 UI / ui 层无数据库知识」在 Web 侧的对等物。
 */

import type { ConnectionSummary, DbStudioApi } from '../core/api'
import type { ConnectionConfig } from '../core/dialect'
import type { DialectField, DialectInfo } from '../core/driver'
import type { ObjectRef, TableDescription } from '../core/model'
import { MetadataTree } from './tree'
import { ResultTabs } from './tabs'

declare global {
  interface Window {
    dbstudio?: DbStudioApi
  }
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`页面缺少必需元素: #${id}`)
  return node as T
}

function setStatus(text: string, isError = false): void {
  const bar = el('status-bar')
  bar.textContent = text
  bar.classList.toggle('is-error', isError)
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/**
 * 启动。
 *
 * 第一件事是检查 `window.dbstudio` 是否存在。
 * 如果直接用浏览器打开 index.html（没有 preload），它会不存在——
 * 此时给一句人能看懂的话，而不是抛一堆 TypeError 白屏。
 */
async function boot(): Promise<void> {
  const api = window.dbstudio
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:32px;font:14px/1.7 -apple-system,sans-serif">' +
      '<h2 style="margin-top:0">需要 Electron 环境</h2>' +
      '<p>这个界面通过 preload 暴露的 <code>window.dbstudio</code> 与主进程通信。' +
      '当前页面没有该对象，说明它被当成了普通网页打开。</p>' +
      '<p>请用 <code>pnpm dev</code> 启动。</p></div>'
    return
  }

  // ---- 结果集多标签接线 ----
  //
  // 之前这里是 `new ResultGrid(...)` 单实例。现在改成由 ResultTabs 统一管理：
  // 每查一次就**新开**一个标签，标签内部各自持有一个独立的 ResultGrid 实例
  // （见 tabs.ts 文件头：改外层、多实例化，绝不复制 grid.ts 的代码）。
  const tabs = new ResultTabs(
    el('result-tabs-scroll'),
    el('result-stack'),
    el('result-tabs-empty'),
    el<HTMLButtonElement>('btn-export-all'),
    api,
    { onStatus: (t, isErr) => setStatus(t, isErr) }
  )

  // 网格需要知道「当前在哪个连接上执行 SQL」，所以记住最近选中的连接子树节点。
  let currentConnectionNodeId: string | null = null

  const showPane = (which: 'detail' | 'grid' | 'empty'): void => {
    el('detail-empty').hidden = which !== 'empty'
    el('detail-content').hidden = which !== 'detail'
    el('result-area').hidden = which !== 'grid'
  }

  /** 选中表/视图 → **新开**一个结果标签（不再替换当前结果）。 */
  const openTableGrid = async (ref: ObjectRef): Promise<void> => {
    showPane('grid')
    try {
      const desc = await api.describeTable(ref.id)
      // 来源（ref + desc）在调用点记下，tabs 会把它绑定到该标签，供「导出全部」重查。
      await tabs.openTable(ref, desc)
    } catch (e) {
      setStatus(`打开表失败：${errText(e)}`, true)
    }
  }

  /** 统一的节点选中处理：先记录连接归属，再按节点类型分流。 */
  const onSelectNode = (ref: ObjectRef | null): void => {
    if (!ref) return
    // 子节点 id 形如 `connection:c1|table:users`；连接节点形如 `connection:c1`。
    // runQuery 需要的正是 `connection:<id>` 这个前缀部分。
    if (ref.kind === 'connection') {
      currentConnectionNodeId = ref.id
    } else if (ref.id.startsWith('connection:')) {
      currentConnectionNodeId = ref.id.split('|')[0] ?? null
    }

    if (ref.kind === 'table' || ref.kind === 'view') {
      void openTableGrid(ref)
    } else {
      void showDetail(api, ref, () => tree.loadRoots())
    }
  }

  const tree = new MetadataTree(
    el('tree-viewport'),
    el('tree-spacer'),
    el('tree-rows'),
    (nodeId) => api.listChildren(nodeId),
    {
      onStatus: (t, isErr) => setStatus(t, isErr),
      onSelect: onSelectNode,
      // 树面板左上角的摘要。原先这个元素写死在 HTML 里，连上库也显示「未连接」。
      onSummary: (t) => {
        el('tree-summary').textContent = t
      }
    }
  )

  // ---- SQL 执行条 ----
  const runSql = async (): Promise<void> => {
    const input = el<HTMLInputElement>('sql-input')
    const sql = input.value.trim()
    if (!sql) return
    if (!currentConnectionNodeId) {
      setStatus('请先在左侧选择一个连接再执行 SQL', true)
      return
    }
    showPane('grid')
    // 每次执行都**新开**一个标签（标签名取 SQL 前若干字符），而不是替换上次结果。
    await tabs.runSql(currentConnectionNodeId, sql)
  }

  el('btn-run-sql').addEventListener('click', () => void runSql())
  el('sql-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void runSql()
  })

  el('btn-refresh').addEventListener('click', () => {
    void tree.loadRoots()
  })
  el('btn-new-connection').addEventListener('click', () => {
    void openConnectionDialog(api, () => void tree.loadRoots())
  })

  await tree.loadRoots()
}

/**
 * 右侧详情：表结构 + 唯一键警告；连接节点则给出连接/断开/删除操作。
 *
 * `reloadTree` 从外部注入而不是直接引用 tree：
 * 这个函数在 boot() 里也可被复用，直接闭包引用会让依赖关系变成隐式的。
 */
async function showDetail(
  api: DbStudioApi,
  ref: ObjectRef,
  reloadTree: () => Promise<void>
): Promise<void> {
  const empty = el('detail-empty')
  const content = el('detail-content')

  // 非表/视图节点没有列结构可展示。
  if (ref.kind !== 'table' && ref.kind !== 'view') {
    empty.hidden = false
    content.hidden = false
    content.replaceChildren()

    if (ref.kind === 'connection') {
      // 连接节点：展示持久化/会话状态，并按需给出「连接 / 断开 / 删除」操作。
      //
      // 为什么要这三个按钮：加了持久化之后，连接不再是「存在即已连上」。
      // 启动时只载入配置不建立会话（否则启动会挨个连库、慢且可能弹一堆错误），
      // 所以用户必须能手动把一条已保存的连接接上。
      const h2 = document.createElement('h2')
      h2.textContent = ref.name
      content.appendChild(h2)

      const meta = document.createElement('div')
      meta.className = 'detail-sub'
      const connected = ref.meta?.['connected'] === true
      const persisted = ref.meta?.['persisted'] === true
      // secretStored 三态：null=不需要密码；true=已加密保存；false=需要密码但存不下。
      // 用 `=== false` 而不是 `!x`，否则 null（不需要密码）会被误判成"没存"。
      const secretStored = ref.meta?.['secretStored']
      meta.textContent =
        `${String(ref.meta?.['dialect'] ?? '未知方言')} · ` +
        (connected ? '已连接' : '未连接') +
        (persisted ? ' · 配置已保存' : ' · 配置未保存')
      content.appendChild(meta)

      // 密码存不下时必须显著提示。否则用户重启后连接失败，却完全不知道为什么——
      // 这种"看起来成功、实际少了关键部分"比直接报错更糟。
      if (secretStored === false) {
        const warn = document.createElement('div')
        warn.className = 'warn-banner'
        warn.textContent =
          '⚠ 密码未保存：当前系统不支持安全存储（如缺少 keyring）。' +
          '配置已保存，但重启后需要重新输入密码。'
        content.appendChild(warn)
      }

      const bar = document.createElement('div')
      bar.className = 'conn-actions'

      // 仅在连接归属的节点 id 上操作（`connection:<id>` → `<id>`）。
      const connId = ref.id.startsWith('connection:') && !ref.id.includes('|')
        ? ref.id.slice('connection:'.length)
        : null

      if (connId) {
        if (!connected) {
          bar.appendChild(
            actionButton('连接', async () => {
              setStatus('正在连接…')
              try {
                await api.connectConnection(connId)
                setStatus(`已连接：${ref.name}`)
                await reloadTree()
              } catch (e) {
                setStatus(`连接失败：${errText(e)}`, true)
              }
            })
          )
        } else {
          bar.appendChild(
            actionButton('断开', async () => {
              setStatus('正在断开…')
              try {
                await api.disconnectConnection(connId)
                setStatus(`已断开：${ref.name}（配置仍保留）`)
                await reloadTree()
              } catch (e) {
                setStatus(`断开失败：${errText(e)}`, true)
              }
            })
          )
        }
        bar.appendChild(
          actionButton('删除连接', async () => {
            // 用原生 confirm 简单确认。删除会同时清掉保存的配置与凭据，不可撤销。
            if (!globalThis.confirm(`确定删除连接「${ref.name}」？配置与保存的密码都会被删除。`)) {
              return
            }
            try {
              await api.removeConnection(connId)
              setStatus(`已删除：${ref.name}`)
              await reloadTree()
            } catch (e) {
              setStatus(`删除失败：${errText(e)}`, true)
            }
          })
        )
      }
      content.appendChild(bar)
      return
    }

    empty.hidden = false
    content.hidden = true
    empty.textContent = `「${ref.name}」不是表或视图，没有列结构。`
    return
  }

  empty.hidden = true
  content.hidden = false
  content.replaceChildren(loadingNode('正在读取表结构…'))

  let desc: TableDescription
  try {
    desc = await api.describeTable(ref.id)
  } catch (e) {
    content.replaceChildren()
    const err = document.createElement('div')
    err.className = 'warn-banner'
    err.textContent = `读取表结构失败：${errText(e)}`
    content.appendChild(err)
    return
  }

  content.replaceChildren()

  const h2 = document.createElement('h2')
  h2.textContent = ref.name
  content.appendChild(h2)

  const sub = document.createElement('div')
  sub.className = 'detail-sub'
  sub.textContent = `${ref.kind === 'view' ? '视图' : '表'} · ${desc.columns.length} 列`
  content.appendChild(sub)

  // 无唯一键 → 不可在线编辑。这是从 DBeaver 的
  // `ResultSetPersister.checkEntityIdentifiers`（缺 DBDRowIdentifier 直接报
  // "No unique key defined"）提炼出来的规则，提前告知而不是等用户改了才报错。
  if (!desc.hasUniqueKey) {
    const warn = document.createElement('div')
    warn.className = 'warn-banner'
    warn.innerHTML =
      '<span aria-hidden="true">⚠</span><span>' +
      '<strong>该对象没有唯一键（主键）。</strong><br/>' +
      '因此无法在线编辑它的数据——Update/Delete 需要能唯一定位一行的标识。' +
      '这与 DBeaver 的行为一致（缺唯一键时抛出 “No unique key defined”）。' +
      '</span>'
    content.appendChild(warn)
  }

  const table = document.createElement('table')
  table.className = 'columns'
  const thead = document.createElement('thead')
  thead.innerHTML =
    '<tr><th scope="col">列名</th><th scope="col">类型</th>' +
    '<th scope="col">可空</th><th scope="col">主键</th><th scope="col">默认值</th></tr>'
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  for (const c of desc.columns) {
    const tr = document.createElement('tr')

    const nameTd = document.createElement('td')
    nameTd.textContent = c.name
    tr.appendChild(nameTd)

    const typeTd = document.createElement('td')
    typeTd.className = 'type'
    typeTd.textContent = c.typeName
    tr.appendChild(typeTd)

    const nulTd = document.createElement('td')
    nulTd.textContent = c.nullable ? '是' : '否'
    tr.appendChild(nulTd)

    const pkTd = document.createElement('td')
    if (c.primaryKeyOrdinal !== null) {
      const badge = document.createElement('span')
      badge.className = 'pk-badge'
      badge.textContent = `PK${c.primaryKeyOrdinal > 1 ? c.primaryKeyOrdinal : ''}`
      pkTd.appendChild(badge)
    } else {
      pkTd.textContent = '—'
    }
    tr.appendChild(pkTd)

    const defTd = document.createElement('td')
    defTd.className = 'type'
    defTd.textContent = c.defaultValue ?? '—'
    tr.appendChild(defTd)

    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  content.appendChild(table)
}

function loadingNode(text: string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'detail-sub'
  div.textContent = text
  return div
}

/** 造一个带异步点击处理的按钮，期间禁用防止连点。 */
function actionButton(label: string, onClick: () => Promise<void>): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.addEventListener('click', () => {
    btn.disabled = true
    void onClick().finally(() => {
      btn.disabled = false
    })
  })
  return btn
}

// ---------------------------------------------------------------------------
// 新建连接对话框
// ---------------------------------------------------------------------------

let cachedDialects: DialectInfo[] | null = null

async function openConnectionDialog(api: DbStudioApi, onConnected: () => void): Promise<void> {
  const dlg = el<HTMLDialogElement>('dlg-connection')
  const sel = el<HTMLSelectElement>('f-dialect')
  const dyn = el('f-dynamic')
  const errP = el('f-error')
  const nameInput = el<HTMLInputElement>('f-name')

  try {
    cachedDialects ??= await api.listDialects()
  } catch (e) {
    setStatus(`读取方言列表失败：${errText(e)}`, true)
    return
  }

  // 填充方言下拉。每次都重建，避免上次的选项残留。
  sel.replaceChildren()
  for (const d of cachedDialects) {
    const opt = document.createElement('option')
    opt.value = d.id
    opt.textContent = `${d.name}（${d.id}）`
    sel.appendChild(opt)
  }

  const renderFields = (): void => {
    const dialect = cachedDialects?.find((d) => d.id === sel.value)
    dyn.replaceChildren()
    if (!dialect) return
    for (const f of dialect.fields) {
      dyn.appendChild(buildField(f))
    }
  }
  renderFields()
  sel.onchange = renderFields

  errP.hidden = true
  nameInput.value = ''

  /** 收集表单 → ConnectionConfig + secret。密码单独走 secret，绝不进 options。 */
  const collect = (): { config: ConnectionConfig; secret: string | undefined } => {
    const dialect = cachedDialects?.find((d) => d.id === sel.value)
    if (!dialect) throw new Error('请选择数据库类型')
    const options: Record<string, string | number | boolean> = {}
    let secret: string | undefined
    for (const f of dialect.fields) {
      const input = dyn.querySelector<HTMLInputElement>(`[data-key="${cssEscape(f.key)}"]`)
      if (!input) continue
      const raw = input.value.trim()
      if (raw === '') {
        if (f.required) throw new Error(`请填写「${f.label}」`)
        continue
      }
      if (f.kind === 'password') {
        secret = raw
      } else if (f.kind === 'number') {
        const n = Number(raw)
        if (Number.isNaN(n)) throw new Error(`「${f.label}」必须是数字`)
        options[f.key] = n
      } else {
        options[f.key] = raw
      }
    }
    const name = nameInput.value.trim() || dialect.name
    return { config: { dialectId: dialect.id, name, options }, secret }
  }

  el('btn-test').onclick = () => {
    void (async () => {
      errP.hidden = true
      setStatus('正在测试连接…')
      try {
        const { config, secret } = collect()
        const res = await api.testConnection(config, secret)
        if (res.ok) {
          setStatus(
            `连接成功（${res.elapsedMs}ms${res.serverVersion ? ` · ${res.serverVersion}` : ''}）`
          )
        } else {
          setStatus(`连接失败：${res.message ?? '未知原因'}`, true)
        }
      } catch (e) {
        errP.textContent = errText(e)
        errP.hidden = false
        setStatus('测试连接失败', true)
      }
    })()
  }

  el('btn-cancel').onclick = () => {
    dlg.close()
  }

  const form = el<HTMLFormElement>('form-connection')
  form.onsubmit = (e) => {
    e.preventDefault()
    void (async () => {
      errP.hidden = true
      el<HTMLButtonElement>('btn-submit').disabled = true
      setStatus('正在连接…')
      try {
        const { config, secret } = collect()
        const summary: ConnectionSummary = await api.addConnection(config, secret)
        dlg.close()
        setStatus(`已连接：${summary.name}`)
        onConnected()
      } catch (err) {
        errP.textContent = errText(err)
        errP.hidden = false
        setStatus('连接失败', true)
      } finally {
        el<HTMLButtonElement>('btn-submit').disabled = false
      }
    })()
  }

  dlg.showModal()
}

/** 按 `DialectField.kind` 动态造一个表单行。四种 kind 都要支持。 */
function buildField(f: DialectField): HTMLElement {
  const wrap = document.createElement('label')
  wrap.className = 'field'

  const label = document.createElement('span')
  label.textContent = f.required ? `${f.label} *` : f.label
  wrap.appendChild(label)

  const input = document.createElement('input')
  input.dataset['key'] = f.key
  input.type = f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'
  if (f.placeholder) input.placeholder = f.placeholder
  if (f.default !== undefined) input.value = String(f.default)
  input.required = f.required

  if (f.kind === 'file') {
    // 文件选择：用一个只读文本框 + 「浏览」按钮。Electron 里真正调
    // 系统文件对话框需要主进程配合，这里先用纯文本输入，避免为了一个
    // 可选 UI 细节把 IPC 面再开大一次。
    input.placeholder = f.placeholder ?? '输入绝对路径，例如 /tmp/sample.db'
  }

  wrap.appendChild(input)
  return wrap
}

/** CSS 属性选择器转义，避免 key 里的特殊字符导致 querySelector 抛错。 */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

// 启动。任何未捕获异常都要显示到状态栏，不能白屏。
boot().catch((e) => {
  setStatus(`启动失败：${errText(e)}`, true)
  console.error(e)
})
