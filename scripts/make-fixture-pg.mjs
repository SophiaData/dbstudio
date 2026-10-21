/**
 * 生成端到端测试用的 **PostgreSQL** 夹具库。
 *
 * ===== 设计原则：本机可能没有 PG 服务，绝不能硬失败 =====
 *
 * 连接串从环境变量 `DBSTUDIO_PG_URL` 读（如 `postgres://postgres:postgres@127.0.0.1:5432/postgres`）。
 * 没有这个变量、或连不上，都**打印说明并 exit 0（跳过）**——
 * 这是 task 明确要求的：缺环境不算失败，假装验证过才是。
 *
 * ===== 夹具为什么这样设计（每条对应一条待验证的契约）=====
 *
 *   pg_users       有单列主键（id SERIAL）     → hasUniqueKey === true、primaryKeyOrdinal === 1
 *   pg_flags       有 BOOLEAN 列                → 验证 PG 真布尔（SQLite 只有 0/1）
 *   pg_log         故意不给主键                 → hasUniqueKey === false（"No unique key defined" 不可编辑）
 *   "MixedCase"    带引号、大小写混合的表/列     → 验证 PG 大小写折叠与引号
 *   pg_active      视图                        → 验证 views 分组能列出视图
 *   public / 以及额外建一个 second schema       → 验证 schema 层（PG 特有）能被列出
 *
 * 幂等：先 DROP 再 CREATE，重复执行结果一致。
 *
 * 运行：DBSTUDIO_PG_URL=... node scripts/make-fixture-pg.mjs
 */

import pg from 'pg'

const url = process.env['DBSTUDIO_PG_URL']

if (!url) {
  console.log('[make-fixture-pg] 跳过：未配置 DBSTUDIO_PG_URL 环境变量。')
  console.log('[make-fixture-pg] 例：DBSTUDIO_PG_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres node scripts/make-fixture-pg.mjs')
  process.exit(0)
}

const SECOND_SCHEMA = 'dbstudio_demo'

const DDL = `
  -- ===== public schema =====
  DROP VIEW  IF EXISTS public.pg_active;
  DROP TABLE IF EXISTS public.pg_log;
  DROP TABLE IF EXISTS public.pg_flags;
  DROP TABLE IF EXISTS public.pg_users;
  DROP TABLE IF EXISTS public."MixedCase";

  -- 有主键的表：在线编辑的前提。SERIAL 是 PG 的自增写法（不是 AUTOINCREMENT）
  CREATE TABLE public.pg_users (
    id         SERIAL PRIMARY KEY,
    email      TEXT NOT NULL,
    age        INTEGER,
    score      NUMERIC(10,2),
    created_at TIMESTAMPTZ DEFAULT now()
  );
  INSERT INTO public.pg_users (email, age, score) VALUES
    ('alice@example.com', 30, 99.50),
    ('bob@example.com',   25, 88.00),
    ('carol@example.com', NULL, NULL);

  -- BOOLEAN 列：PG 有真布尔，与 SQLite 的 0/1 不同
  CREATE TABLE public.pg_flags (
    id       SERIAL PRIMARY KEY,
    name     TEXT NOT NULL,
    enabled  BOOLEAN NOT NULL DEFAULT true
  );
  INSERT INTO public.pg_flags (name, enabled) VALUES ('feature_a', true), ('feature_b', false);

  -- 无主键的表：用来验证「不可在线编辑」
  CREATE TABLE public.pg_log (
    action TEXT,
    at     TIMESTAMPTZ DEFAULT now()
  );
  INSERT INTO public.pg_log (action) VALUES ('login'), ('logout');

  -- 引号 + 大小写混合：未加引号会折叠成小写，这里刻意用引号保留大小写
  CREATE TABLE public."MixedCase" (
    "Id"   INTEGER PRIMARY KEY,
    "Name" TEXT
  );
  INSERT INTO public."MixedCase" ("Id", "Name") VALUES (1, 'one'), (2, 'two');

  CREATE VIEW public.pg_active AS
    SELECT id, email FROM public.pg_users WHERE email IS NOT NULL;

  -- ===== 第二个 schema：验证 PG 的 schema 层 =====
  DROP SCHEMA IF EXISTS ${SECOND_SCHEMA} CASCADE;
  CREATE SCHEMA ${SECOND_SCHEMA};
  CREATE TABLE ${SECOND_SCHEMA}.items (
    id   SERIAL PRIMARY KEY,
    name TEXT NOT NULL
  );
  INSERT INTO ${SECOND_SCHEMA}.items (name) VALUES ('widget'), ('gadget');
`

const client = new pg.Client({ connectionString: url })
try {
  await client.connect()
  console.log('[make-fixture-pg] 已连接，开始建夹具...')
  await client.query(DDL)
  const counts = await client.query(`
    SELECT 'pg_users' AS t, count(*)::int AS n FROM public.pg_users
    UNION ALL SELECT 'pg_flags', count(*)::int FROM public.pg_flags
    UNION ALL SELECT 'pg_log', count(*)::int FROM public.pg_log
    UNION ALL SELECT 'MixedCase', count(*)::int FROM public."MixedCase"
    UNION ALL SELECT 'demo.items', count(*)::int FROM ${SECOND_SCHEMA}.items
  `)
  for (const row of counts.rows) console.log(`[make-fixture-pg]   ${row.t}: ${row.n} 行`)
  console.log('[make-fixture-pg] ✅ 夹具就绪')
} catch (err) {
  // 连不上：按"跳过"处理（不硬失败），但把原因打印清楚
  console.log(`[make-fixture-pg] 跳过：无法连接或建表失败 —— ${err instanceof Error ? err.message : String(err)}`)
  console.log('[make-fixture-pg] 请确认 DBSTUDIO_PG_URL 指向一个可用且可写的 PostgreSQL。')
  process.exitCode = 0
} finally {
  await client.end().catch(() => undefined)
}
