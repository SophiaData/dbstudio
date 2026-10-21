/**
 * 生成端到端测试用的 SQLite 夹具库。
 *
 * 这个夹具的每一处设计都对应一条待验证的契约，不是随手造的样例数据：
 *
 *   users           有单列主键          → 验证 hasUniqueKey === true、primaryKeyOrdinal === 1
 *   audit_log       故意不给主键        → 验证 hasUniqueKey === false（对应 DBeaver
 *                                        "No unique key defined" 时不可在线编辑的规则）
 *   active_users    视图                → 验证 views 分组能列出视图
 *   含 sqlite_ 内部表的副作用          → 验证列表会排除 sqlite_ 前缀（见下）
 *
 * 关于「内部表」：`sqlite_sequence` 只有在库里有 AUTOINCREMENT 列时才出现。
 * 所以这里**刻意建一张带 AUTOINCREMENT 的临时表**，
 * 让 internal 表必然存在，从而使「列表必须过滤 sqlite_%」这条断言真的有区分度。
 * 若不加这一步，SQLite 库里根本没有 sqlite_ 表，断言会在「没测到」的情况下假通过。
 *
 * 幂等：先 DROP 再 CREATE，重复执行结果一致。
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = resolve(root, 'tests/fixtures/sample.db')

mkdirSync(dirname(dbPath), { recursive: true })

const db = new DatabaseSync(dbPath)

// 顺序很重要：先删依赖方（视图），再删被依赖的表。
db.exec(`
  DROP VIEW  IF EXISTS active_users;
  DROP TABLE IF EXISTS audit_log;
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS _seq_probe;
`)

db.exec(`
  -- 有主键的表：在线编辑的前提
  CREATE TABLE users (
    id         INTEGER PRIMARY KEY,
    email      TEXT NOT NULL UNIQUE,
    created_at TEXT
  );

  -- 无主键的表：用来验证「不可在线编辑」的判定
  CREATE TABLE audit_log (
    id     INTEGER,
    action TEXT,
    at     TEXT
  );

  CREATE VIEW active_users AS
    SELECT id, email FROM users WHERE email IS NOT NULL;

  -- 只为让 sqlite_sequence 这个内部表出现（见文件头说明），建完立刻删。
  -- 删掉表不会删掉 sqlite_sequence 本身，它一旦被创建就会留在这个库文件里。
  CREATE TABLE _seq_probe (id INTEGER PRIMARY KEY AUTOINCREMENT);
  DROP TABLE _seq_probe;
`)

db.exec(`
  DELETE FROM users;
  DELETE FROM audit_log;
  INSERT INTO users (id, email, created_at) VALUES
    (1, 'alice@example.com', '2026-01-01T00:00:00Z'),
    (2, 'bob@example.com',   '2026-01-02T00:00:00Z'),
    (3, 'carol@example.com', '2026-01-03T00:00:00Z');
  INSERT INTO audit_log (id, action, at) VALUES
    (1, 'login',  '2026-01-01T00:00:00Z'),
    (2, 'logout', '2026-01-01T01:00:00Z');
`)

// 自检：确认夹具本身符合预期，避免「夹具造假导致测试假通过」。
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  )
  .all()
  .map((r) => r.name)

const hasInternal = tables.some((n) => String(n).startsWith('sqlite_'))
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c

db.close()

console.log(`[make-fixture] 已生成 ${dbPath}`)
console.log(`[make-fixture] 表: ${tables.join(', ')}`)
console.log(`[make-fixture] users 行数: ${userCount}`)
console.log(`[make-fixture] 存在 sqlite_ 内部表: ${hasInternal ? '是（保证过滤断言有区分度）' : '否（过滤断言将无法验证！）'}`)

if (!hasInternal) {
  console.error('[make-fixture] 警告：没能造出 sqlite_ 内部表，过滤相关断言会失去区分度。')
  process.exitCode = 1
}
