/**
 * 截获渲染进程里的「导出下载」内容，供 GUI 测试断言。
 *
 * 为什么不能靠监听 Playwright 的 download 事件：
 * 应用导出走的是 `<a download>` + `URL.createObjectURL(blob)`，Electron 里并没有
 * 落盘动作，Playwright 收不到可下载的文件。
 *
 * 为什么不能靠 `fetch(blobUrl)` 再 `.text()`：
 * 应用在 `setTimeout(0)` 里就 `revokeObjectURL`，与 fetch 竞争——实测经常拿到空串，
 * 断言会变成「恒真假阳性」或「恒假假阴性」。
 *
 * 可靠做法：**在 createObjectURL 时就留住 Blob 本体**，点击时直接读它。
 */

/**
 * 在页面里安装下载捕获。
 *
 * @param {import('playwright-core').Page} win
 */
export async function installDownloadCapture(win) {
  await win.exposeFunction('__recordDownload', (name, text) => {
    downloads.push({ name, text })
  })
  await win.evaluate(() => {
    /** @type {Map<string, Blob>} */
    const blobs = new Map()
    const originalCreate = URL.createObjectURL.bind(URL)
    const originalClick = HTMLAnchorElement.prototype.click

    URL.createObjectURL = (obj) => {
      const url = originalCreate(obj)
      if (obj instanceof Blob) blobs.set(url, obj)
      return url
    }

    HTMLAnchorElement.prototype.click = function patched() {
      const blob = this.download ? blobs.get(this.href) : undefined
      if (!blob) return originalClick.call(this)
      const name = this.download
      void blob.text().then(
        (text) => window.__recordDownload(name, text),
        () => window.__recordDownload(name, '')
      )
      return undefined
    }
  })
}

/** @type {{ name: string, text: string }[]} */
export const downloads = []

/** 清空已捕获的下载（测下一条导出路径前调用）。 */
export function resetDownloads() {
  downloads.length = 0
}

