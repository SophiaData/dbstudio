/**
 * SQLite 方言的展示信息：UI 的「新建连接」下拉框与动态表单用它。
 *
 * 为什么单独一个文件而不是写在 `index.ts` 里：
 * `DriverAdapter` 接口要求实例上带 `info`，于是 adapter 需要引用它；
 * 若它定义在 `index.ts`，就会形成 `index → adapter → index` 的循环导入。
 * ESM 下循环导入不一定报错，但"哪个模块先初始化"会变成运气问题——
 * 这里直接用一个叶子模块把这个风险消掉。
 */

import type { DialectInfo } from '../../core/driver'
import { SQLITE_SCRIPT_RULES } from '../../core/sql-script'
import { SQLITE_DIALECT_ID } from './dialect'

export const SQLITE_INFO: DialectInfo = {
  id: SQLITE_DIALECT_ID,
  name: 'SQLite',
  /**
   * 只暴露一个字段：SQLite 的连接串就是文件路径。
   * 不提供 user/password——SQLite 没有服务端身份认证，
   * 摆一个填了也没用的密码框只会让用户以为它有用。
   */
  fields: [
    {
      key: 'file',
      label: '数据库文件',
      kind: 'file',
      required: true,
      placeholder: '/绝对路径/数据库.db'
    }
  ],
  /**
   * 引号规则，供主进程/UI 拼 SQL 时使用。
   *
   * 必须与 `dialect.ts` 的 `quoteIdentifier` **完全一致**（双引号 + 内部引号翻倍）。
   * 两处不一致会产生最难查的偏差：主进程拼的 SQL 与驱动拼的不是同一种写法，
   * 普通表名上看不出问题，一到含引号的标识符就炸，而且只在一侧炸。
   * 所以这条规则的含义被刻意定义成"quoteIdentifier 的声明式描述"，
   * 而不是另一套独立的引号设置。
   */
  quoting: { open: '"', close: '"', escape: 'double' },
  scriptRules: SQLITE_SCRIPT_RULES
}
