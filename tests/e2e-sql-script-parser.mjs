import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dbstudio-sql-script-parser-'))

await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    ssr: true,
    rollupOptions: {
      external: [/^node:/],
      output: { entryFileNames: 'probe.cjs' }
    },
    lib: { entry: resolve(root, 'src/core/sql-script.ts'), formats: ['cjs'] }
  }
})

const {
  SQLITE_SCRIPT_RULES,
  POSTGRESQL_SCRIPT_RULES,
  splitStatements
} = await import(`file://${join(outDir, 'probe.cjs')}`)

function statements(sql, rules) {
  return splitStatements(sql, rules).map((statement) => ({
    sql: statement.sql,
    startLine: statement.startLine,
    endLine: statement.endLine
  }))
}

try {
  assert.deepEqual(
    statements(
      "SELECT 'a;b' AS value; SELECT \"quoted;name\" FROM items;",
      SQLITE_SCRIPT_RULES
    ).map((statement) => statement.sql),
    ["SELECT 'a;b' AS value", 'SELECT "quoted;name" FROM items']
  )

  assert.deepEqual(
    statements(
      'SELECT 1; -- comment with ;\n/* block ; comment */ SELECT 2;',
      SQLITE_SCRIPT_RULES
    ).map((statement) => statement.sql),
    ['SELECT 1', '-- comment with ;\n/* block ; comment */ SELECT 2']
  )

  assert.deepEqual(
    statements(
      [
        'CREATE FUNCTION demo() RETURNS void AS $$',
        "BEGIN RAISE NOTICE 'inside;body'; END;",
        '$$ LANGUAGE plpgsql;',
        'SELECT 1;'
      ].join('\n'),
      POSTGRESQL_SCRIPT_RULES
    ).map((statement) => statement.sql),
    [
      [
        'CREATE FUNCTION demo() RETURNS void AS $$',
        "BEGIN RAISE NOTICE 'inside;body'; END;",
        '$$ LANGUAGE plpgsql'
      ].join('\n'),
      'SELECT 1'
    ]
  )

  assert.deepEqual(
    statements(
      [
        'CREATE FUNCTION demo() RETURNS void AS $body$',
        "BEGIN RAISE NOTICE 'inside;body'; END;",
        '$body$ LANGUAGE plpgsql;',
        'SELECT 2;'
      ].join('\n'),
      POSTGRESQL_SCRIPT_RULES
    ).map((statement) => statement.sql),
    [
      [
        'CREATE FUNCTION demo() RETURNS void AS $body$',
        "BEGIN RAISE NOTICE 'inside;body'; END;",
        '$body$ LANGUAGE plpgsql'
      ].join('\n'),
      'SELECT 2'
    ]
  )

  assert.deepEqual(
    statements(
      [
        'CREATE TRIGGER audit AFTER INSERT ON items',
        'BEGIN',
        "  INSERT INTO log VALUES ('one;two');",
        '  UPDATE counters SET count = count + 1;',
        'END;',
        'SELECT 3;'
      ].join('\n'),
      SQLITE_SCRIPT_RULES
    ).map((statement) => statement.sql),
    [
      [
        'CREATE TRIGGER audit AFTER INSERT ON items',
        'BEGIN',
        "  INSERT INTO log VALUES ('one;two');",
        '  UPDATE counters SET count = count + 1;',
        'END'
      ].join('\n'),
      'SELECT 3'
    ]
  )

  const located = splitStatements(
    '\n\nSELECT 1\nFROM items;\n\nSELECT 2;',
    SQLITE_SCRIPT_RULES
  )
  assert.equal(located[0].startOffset, 2)
  assert.equal(located[0].startLine, 3)
  assert.equal(located[0].endLine, 4)
  assert.equal(located[1].startLine, 6)
  assert.equal(located[1].endLine, 6)

  assert.deepEqual(
    statements('SELECT 1;; -- trailing comment\n', SQLITE_SCRIPT_RULES).map(
      (statement) => statement.sql
    ),
    ['SELECT 1']
  )

  assert.throws(
    () => splitStatements("SELECT 'unterminated;", SQLITE_SCRIPT_RULES),
    (error) => /未闭合|unclosed/i.test(error.message) && error.line === 1
  )
  assert.throws(
    () => splitStatements('SELECT 1 /* unterminated', SQLITE_SCRIPT_RULES),
    (error) => /未闭合|unclosed/i.test(error.message) && error.line === 1
  )

  console.log('SQL script parser: 8 cases passed')
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
