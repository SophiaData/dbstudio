/**
 * CSV 导入的「系统文件选择器」逻辑。
 *
 * ===== 为什么这一层要单独拆出来 =====
 *
 * 主进程入口 `src/main/index.ts` 在**模块加载时**就会
 * `import { app, BrowserWindow, dialog } from 'electron'` 并执行
 * `app.whenReady()`。这意味着纯 Node 进程**根本 import 不了它**——
 * 于是这段"打开对话框 → 归一化返回值"的逻辑就只能靠字符串 grep 验证，
 * 那不是验证，是自我安慰。
 *
 * 所以这里把逻辑拆成一个**零依赖、依赖注入**的纯模块：
 *   - 它不认识 `electron`，只认识"给我一个能弹框的函数"；
 *   - 测试可以用假 dialog 真实驱动它（选中 / 取消 / 抛错 / 窗口已销毁）；
 *   - 主进程只负责把真 `dialog.showOpenDialog` 与真 `BrowserWindow` 注入进来。
 *
 * ===== 这条能力的边界（刻意收得很紧） =====
 *
 * 1. **只返回一个路径**。不读文件、不回传 CSV 内容——
 *    内容解析是主进程 `previewImport` / `startImport` 的事。
 * 2. **只给用户真正选中的东西**。取消 → `null`；没选 → `null`；
 *    对话框抛错 → 向调用方传播。**绝不**在失败时"随便返回某个默认路径"，
 *    那等于替用户决定了数据来源，是最危险的一种错。
 * 3. **不接收路径参数**。这条通道只做"弹框"，不做"打开指定文件"。
 * 4. **单选**。`properties` 的类型只允许 `'openFile'`，
 *    连 `'multiSelections'` 都写不进去——从类型层面杜绝多选。
 */

/** 一个"能当对话框父窗口"的最小接口。只有 `isDestroyed` 是必需的。 */
export interface DialogWindowLike {
  isDestroyed(): boolean
}

/**
 * 打开文件对话框的参数。
 *
 * `properties` 的类型被收窄成 `Array<'openFile'>`：
 * 这样连 `'multiSelections'` 都无法被写进类型里，
 * "多选不启用"就不只是约定，而是**编译期强制**。
 */
export interface ImportFileDialogOptions {
  /** 标题栏文案。 */
  title: string
  /** 确认按钮文案。 */
  buttonLabel: string
  /** 只允许 `'openFile'`：单选、只能选文件。 */
  properties: Array<'openFile'>
  /** 文件类型过滤。 */
  filters: Array<{ name: string; extensions: string[] }>
}

/** `dialog.showOpenDialog` 的返回值（只取我们关心的两个字段）。 */
export interface ImportFileDialogResult {
  canceled: boolean
  filePaths: string[]
}

/**
 * 打开文件对话框的能力。
 *
 * `window` 为 `null` 表示没有可用的父窗口；此时不会调用系统对话框，直接返回 `null`。
 */
export type ShowOpenDialog<W extends DialogWindowLike> = (
  window: W | null,
  options: ImportFileDialogOptions
) => Promise<ImportFileDialogResult>

export interface ChooseImportFileDeps<W extends DialogWindowLike> {
  /** 真正弹框的能力（主进程注入 `dialog.showOpenDialog`）。 */
  showOpenDialog: ShowOpenDialog<W>
  /**
   * 按优先级返回候选父窗口。
   *
   * 第一个**存活**的窗口会被用作对话框父窗口（也就是"发起这次调用的窗口"）。
   * 没有存活窗口时直接返回 `null`，不会改用无父窗口对话框。
   */
  resolveWindows: () => Array<W | null | undefined>
}

/**
 * 对话框参数。集中在这里，方便测试直接断言"到底传了什么给系统框"。
 *
 * 过滤器只列 CSV：导入管线只吃 CSV。
 * 想选别的扩展名时，UI 那条"手填绝对路径"的路仍然通着（renderer 侧校验）。
 */
export const IMPORT_FILE_DIALOG_OPTIONS: ImportFileDialogOptions = {
  title: '选择 CSV 文件',
  buttonLabel: '选择',
  properties: ['openFile'],
  filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
}

/**
 * 弹出系统文件选择框，返回用户选中的 CSV 路径。
 *
 * 返回 `null` 的两种情况（且**只有**这两种）：
 *   - 用户点了取消；
 *   - 对话框返回了空列表，或没有存活的父窗口；
 *
 * 对话框异常会原样向调用方传播，方便 UI 显示错误而不是把异常伪装成取消。
 */
export async function chooseImportFile<W extends DialogWindowLike>(
  deps: ChooseImportFileDeps<W>
): Promise<string | null> {
  const [candidate] = deps.resolveWindows()
  const parentWindow = candidate && !candidate.isDestroyed() ? candidate : null
  if (!parentWindow) return null

  const result = await deps.showOpenDialog(parentWindow, IMPORT_FILE_DIALOG_OPTIONS)

  if (!result || result.canceled) return null
  const paths = result.filePaths
  if (!Array.isArray(paths) || paths.length === 0) return null

  const picked = paths[0]
  if (typeof picked !== 'string' || picked.trim() === '') return null
  return picked
}
