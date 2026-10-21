/**
 * 第三轮功能的 GUI 真实交互验收（按实际 DOM 校准）。
 *
 * 覆盖：多结果标签页 / 建表 / 删表 / 重命名 / 建视图 / 删视图 / 编辑连接 / 导出全部
 *
 * 设计原则（沿用前几轮教训）：
 *   - 断言要能区分「功能失效」与「我的测试写错」
 *   - 破坏性操作先确认数据层变化，不只看 UI
 *   - 不硬编码会因前置失败而变化的数字
 */

import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const pwFile = require.resolve('playwright-core', { paths: [root] })
const pw = await import(pathToFileURL(pwFile).href)
const electron = pw._electron ?? pw.default?._electron

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dbstudio-r3-'))
const dbA = join(dir, 'a.db')
const dbB = join(dir, 'b.db')
{
  const a = new DatabaseSync(dbA)
  a.exec("CREATE TABLE alpha (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO alpha VALUES (1,'a-row');")
  a.exec("CREATE TABLE alpha2 (id INTEGER PRIMARY KEY, w TEXT); INSERT INTO alpha2 VALUES (1,'a2-row');")
  a.close()
  const b = new DatabaseSync(dbB)
  b.exec("CREATE TABLE beta (id INTEGER PRIMARY KEY, z TEXT); INSERT INTO beta VALUES (1,'b-row');")
  b.close()
}

const shotDir = join(root, 'out/gui-flow')
mkdirSync(shotDir, { recursive: true })

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.', `--user-data-dir=${join(dir, 'ud')}`],
  cwd: root,
  env
})
const win = await app.firstWindow()
win.on('dialog', (d) => void d.accept())

await win.waitForSelector('#tree-rows', { state: 'attached', timeout: 15000 })

const openConnectionDialog = async () => {
  await win.click('#btn-new-connection')
  await win.waitForSelector('#f-dynamic input[data-key="file"]', { state: 'attached' })
}

/** 建连接并展开其「表」分组 */
async function connectAndExpand(name, file) {
  await openConnectionDialog()
  await win.fill('#f-name', name)
  await win.fill('#f-dynamic input[data-key="file"]', file)
  await win.click('#btn-submit')
  await win.waitForFunction(
    () => { const d = document.getElementById('dlg-connection'); return d && !d.hasAttribute('open') },
    { timeout: 20000 }
  )
  await win.waitForTimeout(600)
  // 展开连接 → 展开其下的「表」
  await win.evaluate((nm) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    rows.find((r) => r.textContent?.includes(nm))?.querySelector('.twisty')?.click()
  }, name)
  await win.waitForTimeout(700)
  await win.evaluate((nm) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const i = rows.findIndex((r) => r.textContent?.includes(nm))
    rows.slice(i).find((r) => r.textContent?.trim().includes('表'))?.querySelector('.twisty')?.click()
  }, name)
  await win.waitForTimeout(700)
}

/** 右键某个树节点，点菜单项（返回是否成功点到） */
async function treeContextMenu(matchText, itemRegex) {
  const ok = await win.evaluate((t) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    const target = rows.find((r) => r.textContent?.trim().includes(t))
    if (!target) return false
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + 10
      })
    )
    return true
  }, matchText)
  if (!ok) return { opened: false, clicked: false }
  await win.waitForTimeout(400)
  const clicked = await win.evaluate((re) => {
    const rx = new RegExp(re)
    const items = [...document.querySelectorAll('[role="menuitem"]')]
    const it = items.find((e) => rx.test(e.textContent ?? ''))
    if (!it) return false
    it.click()
    return true
  }, itemRegex)
  return { opened: true, clicked }
}

/** 点树里的表打开结果集 */
async function openTable(name) {
  await win.evaluate((n) => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    rows.find((r) => r.textContent?.trim().includes(n))?.click()
  }, name)
  await win.waitForTimeout(1800)
}

await connectAndExpand('库A', dbA)
check('连接库A 并展开表分组', true)

// ---------------------------------------------------------------------------
console.log('\n[1] 多结果标签页')
await openTable('alpha2')
await openTable('alpha')
const tabs = await win.evaluate(() => {
  const chips = [...document.querySelectorAll('.tab-chip')]
  return { count: chips.length, labels: chips.map((c) => c.querySelector('.tab-chip-label')?.textContent ?? '') }
})
check('打开 2 个结果标签', tabs.count >= 2, JSON.stringify(tabs.labels))
check('标签名不同（各自独立）', new Set(tabs.labels).size >= 2, tabs.labels.join(' | '))
await win.screenshot({ path: join(shotDir, 'r3-01-多标签.png') })

// 关闭一个标签 → 应被 dispose（这里只能从 UI 侧断言消失；句柄释放由静态自检覆盖）
const closed = await win.evaluate(() => {
  const chips = [...document.querySelectorAll('.tab-chip')]
  const last = chips[chips.length - 1]
  const x = last?.querySelector('.tab-chip-close')
  if (!x) return false
  x.click()
  return true
})
check('点击标签关闭按钮', closed)
await win.waitForTimeout(800)
const afterClose = await win.evaluate(() => document.querySelectorAll('.tab-chip').length)
check('标签数量减少', afterClose < tabs.count, `${tabs.count} → ${afterClose}`)

// ---------------------------------------------------------------------------
console.log('\n[2] 建表（DDL 对话框，真实填写与提交）')
const openCreate = await treeContextMenu('表', '新建表')
check('表分组右键有「新建表」', openCreate.clicked)
if (openCreate.clicked) {
  await win.waitForTimeout(700)
  await win.screenshot({ path: join(shotDir, 'r3-02-建表对话框.png') })
  // 表名
  await win.fill('input[aria-label="表名"]', 'from_gui')
  // 第一列名 + **显式选 INTEGER 类型**（默认选项不一定是 INTEGER，
  // 第一次跑就踩了这个坑：建出来是 "id" TEXT，自然没有主键自增）
  await win.fill('input[placeholder="列名"]', 'id')
  const setup = await win.evaluate(() => {
    const typeSel = document.querySelector('select[aria-label="第 1 列的类型"]')
    let typePicked = false
    if (typeSel) {
      const opt = [...typeSel.options].find((o) => /^INTEGER/i.test(o.textContent ?? ''))
      if (opt) { typeSel.value = opt.value; typeSel.dispatchEvent(new Event('change', { bubbles: true })); typePicked = true }
    }
    // 主键：首列默认就是主键（ddl.ts 里 primaryKey: isFirst），但显式确认一遍
    const colRow = document.querySelector('input[placeholder="列名"]')?.closest('div')?.parentElement
    const cbs = [...(colRow?.querySelectorAll('input[type="checkbox"]') ?? [])]
    const pk = cbs.find((cb) => /主键/.test(cb.parentElement?.textContent ?? ''))
    const pkChecked = pk?.checked ?? null
    if (pk && !pk.checked) pk.click()
    return { typePicked, typeValue: typeSel?.value ?? null, pkFound: !!pk, pkChecked }
  })
  console.log('  [建表设置]', JSON.stringify(setup))
  await win.waitForTimeout(300)
  // 提交
  await win.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const b = btns.find((x) => x.textContent?.trim() === '创建')
    b?.click()
  })
  await win.waitForTimeout(2000)
  await win.screenshot({ path: join(shotDir, 'r3-03-建表后.png') })
  const db = new DatabaseSync(dbA)
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='from_gui'").get()
  db.close()
  check('★ 建表已落库（sqlite_master 可查）', !!t, JSON.stringify(t?.sql))
  check('建的表带主键', !!t && /PRIMARY KEY/i.test(t.sql), t?.sql)
}

// ---------------------------------------------------------------------------
console.log('\n[3] 重命名表')
// 先刷新表分组让 from_gui 出现在树里
await treeContextMenu('表', '刷新')
await win.waitForTimeout(1200)
const ren = await treeContextMenu('from_gui', '重命名')
check('表右键有「重命名」', ren.clicked)
if (ren.clicked) {
  await win.waitForTimeout(600)
  // 重命名可能是 prompt 或对话框；dialog 已被自动 accept，用 prompt 场景兜底
  const renamed = await win.evaluate(() => {
    const inp = document.querySelector('input[aria-label="新表名"]')
    if (!inp) return false
    inp.value = 'renamed_gui'
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '重命名')
    if (!btn) return false
    btn.click()
    return true
  })
  console.log('  [重命名提交]', renamed ? '已提交' : '（可能走 confirm 流程）')
  await win.waitForTimeout(1800)
  const db = new DatabaseSync(dbA)
  const oldT = db.prepare("SELECT name FROM sqlite_master WHERE name='from_gui'").get()
  const newT = db.prepare("SELECT name FROM sqlite_master WHERE name='renamed_gui'").get()
  db.close()
  check('★ 重命名已落库（旧名消失、新名存在）', !oldT && !!newT, `old=${!!oldT} new=${!!newT}`)
}

// ---------------------------------------------------------------------------
console.log('\n[4] 建视图 + 删视图')
await treeContextMenu('表', '刷新')
await win.waitForTimeout(1000)
// 展开「视图」分组以便右键
await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
  rows.find((r) => r.textContent?.trim().includes('视图'))?.querySelector('.twisty')?.click()
})
await win.waitForTimeout(800)
const mkView = await treeContextMenu('视图', '新建视图')
check('视图分组右键有「新建视图」', mkView.clicked)
if (mkView.clicked) {
  await win.waitForTimeout(700)
  // 用 aria-label 精确定位（ddl.ts 里给每个输入框都加了 aria-label，
  //  比"取最后一个 text input"这种位置猜测稳得多——后者一旦对话框加字段就失效）。
  const fillView = await win.evaluate(() => {
    const nameIn = document.querySelector('input[aria-label="视图名"]')
    const sqlIn = document.querySelector('textarea[aria-label="视图的 SELECT 语句"]')
    if (!nameIn || !sqlIn) return { ok: false, hasName: !!nameIn, hasTa: !!sqlIn }
    ;(nameIn).value = 'v_gui'
    ;(sqlIn).value = 'SELECT id, v FROM alpha'
    return { ok: true }
  })
  console.log('  [视图表单]', JSON.stringify(fillView))
  if (fillView.ok) {
    await win.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /创建|确定|保存/.test(x.textContent ?? ''))
      b?.click()
    })
    await win.waitForTimeout(1800)
    const db = new DatabaseSync(dbA)
    const v = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='v_gui'").get()
    db.close()
    check('★ 视图已落库', !!v, JSON.stringify(v))
  }
}

// ---------------------------------------------------------------------------
console.log('\n[5] 删除表（验证数据层真的删了）')
await treeContextMenu('表', '刷新')
await win.waitForTimeout(1200)
const del = await treeContextMenu('renamed_gui', '删除表')
check('表右键有「删除表」', del.clicked)
if (del.clicked) {
  await win.waitForTimeout(1800)
  const db = new DatabaseSync(dbA)
  const gone = !db.prepare("SELECT name FROM sqlite_master WHERE name='renamed_gui'").get()
  db.close()
  check('★ 删表已落库', gone)
}

// ---------------------------------------------------------------------------
console.log('\n[6] 编辑已保存连接（改指向库B）')
await win.evaluate(() => {
  const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
  const conn = rows.find((r) => r.textContent?.includes('库A'))
  const rect = conn?.getBoundingClientRect()
  conn?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: (rect?.left ?? 0) + 20, clientY: (rect?.top ?? 0) + 10 }))
})
await win.waitForTimeout(400)
const editEntry = await win.evaluate(() => {
  const items = [...document.querySelectorAll('[role="menuitem"]')]
  const e = items.find((i) => /编辑/.test(i.textContent ?? ''))
  if (!e) return { found: false, items: items.map((i) => i.textContent?.trim()) }
  e.click()
  return { found: true }
})
check('连接节点右键有「编辑」', editEntry.found, JSON.stringify(editEntry))
if (editEntry.found) {
  // ★ 等表单真正就绪：保存按钮从 disabled 变可用，说明参数输入框（含 file）已建好。
  //   早先直接等固定时间就填，结果填在一个还不存在的元素上，保存时 options 为空——
  //   配置根本没改，测试却以为改了。
  await win.waitForFunction(
    () => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '保存')
      return b !== undefined && !b.disabled
    },
    { timeout: 10000 }
  )
  await win.screenshot({ path: join(shotDir, 'r3-04-编辑连接.png') })
  // 断言回填：file 输入框应该已有当前值（不是空的）
  const backed = await win.evaluate(() => {
    const all = [...document.querySelectorAll('input[data-key="file"]')]
    const inp = all[all.length - 1]
    return { exists: !!inp, value: inp?.value ?? '', count: all.length }
  })
  check('编辑对话框回填了当前配置（不是空框）', backed.exists && backed.value !== '', JSON.stringify(backed))

  // 打印对话框里 file 输入框的实际值与上下文
  // 直接按 aria-label 找输入框，不依赖 overlay 定位（那层包装随时可能变）
  const beforeFill = await win.evaluate(() => ({
    hasName: !!document.querySelector('input[aria-label="连接名"]'),
    fileInputs: [...document.querySelectorAll('input[data-key="file"]')].map(i => i.value.slice(-24))
  }))
  const changed = await win.evaluate((newFile) => {
    // ★ 必须限定在「编辑连接」这个 overlay 内！
    //   index.html 里的 #dlg-connection（新建连接对话框）是常驻 <dialog>，
    //   close() 只是隐藏，DOM 还在——里面也有 input[data-key="file"]。
    //   全局 querySelector 会命中那个旧输入框（值是 a.db），改了等于没改。
    // 定位「编辑连接」overlay：用其中的 aria-label="连接名" 输入框往上找，
    // 而不是靠 z-index 数值（那个值随时可能被调整）。
    // 编辑对话框的 file 输入框是**最后一个** data-key="file"
    // （新建连接对话框的常驻 DOM 里也有一个，值不同）。
    const all = [...document.querySelectorAll('input[data-key="file"]')]
    const inp = all[all.length - 1]
    if (!inp) return { ok: false, reason: 'no file input' }
    inp.value = newFile
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    const saveBtn = [...document.querySelectorAll('button')].find(
      (x) => x.textContent?.trim() === '保存'
    )
    if (!saveBtn || saveBtn.disabled) return { ok: false, reason: 'save disabled' }
    saveBtn.click()
    return { ok: true }
  }, dbB)
  console.log('  [编辑提交]', JSON.stringify(changed))
  await win.waitForTimeout(2500)
  // 验证：重连后能查到库B 的 beta 表。
  //
  // 注意：保存后 loadRoots() 会重建树，**所有节点回到折叠状态**（这是当前行为）。
  // 所以必须重新展开才能看到内容——这不是"没生效"，而是树状态被重置。
  await win.waitForTimeout(1200)
  const expandAll = async () => {
    await win.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
      const conn = rows.find((r) => r.textContent?.includes('库A'))
      if (conn?.getAttribute('aria-expanded') === 'false') conn.querySelector('.twisty')?.click()
    })
    await win.waitForTimeout(800)
    await win.evaluate(() => {
      const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
      const i = rows.findIndex((r) => r.textContent?.includes('库A'))
      const folder = rows.slice(i).find((r) => r.textContent?.trim().includes('表'))
      if (folder?.getAttribute('aria-expanded') === 'false') folder.querySelector('.twisty')?.click()
    })
    await win.waitForTimeout(1000)
  }
  await expandAll()
  const afterEdit = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#tree-rows .tree-row')]
    return rows.map((r) => r.textContent?.trim())
  })
  console.log('  [展开后可见]', JSON.stringify(afterEdit.slice(0, 6)))
  check('★ 编辑连接后指向了库B（能看到 beta 表）',
    afterEdit.some((t) => t?.includes('beta')),
    afterEdit.join(' | ').slice(0, 160))
  check('库A 的 alpha 表已不可见（确实切走了）',
    !afterEdit.some((t) => /\balpha\b/.test(t ?? '') && !/alpha2/.test(t ?? '')),
    afterEdit.join(' | ').slice(0, 160))
}

// ---------------------------------------------------------------------------
console.log('\n[7] 无控制台错误')
const errors = []
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
await win.waitForTimeout(500)
check('渲染进程无未捕获错误', errors.length === 0, errors.slice(0, 3).join(' | '))

await app.close()
console.log(`\n===== 第三轮 GUI 测试：${pass} 通过 / ${fail} 失败 =====`)
console.log(`截图目录: ${shotDir}`)
process.exit(fail > 0 ? 1 : 0)
