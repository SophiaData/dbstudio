import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkWorkbenchLayout({ page, baseUrl, check, output }) {
  for (const [width, height] of [[1180, 760], [1024, 690], [820, 520]]) {
    await check(`full workbench at ${width}x${height} keeps grid, editing and pagination reachable`, async () => {
      await page.setViewportSize({ width, height })
      await page.goto(`${baseUrl}/apps/desktop/tests/workbench-layout-fixture/`)
      await page.locator('[data-node-id="connection:layout"]').dblclick()
      await page.locator('[data-node-id$="|table:items"]').dblclick()
      await page.getByText('已打开 items', { exact: false }).waitFor()
      const grid = page.locator('.grid-scroll')
      // A real scroll viewport must remain even when the toolbars wrap.
      assert.ok(await grid.evaluate(el => el.clientHeight) >= 160, 'grid collapsed below an operable height')
      const first = page.locator('tbody td[data-column-index="1"]').first()
      await first.scrollIntoViewIfNeeded()
      assert.equal(await first.evaluate(el => {
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      }), true, 'first data cell is clipped or covered')
      await first.dblclick()
      await page.getByLabel('单元格值', { exact: true }).fill('layout-edited')
      await page.getByRole('button', { name: '保存到本地修改', exact: true }).click()
      assert.equal(await first.textContent(), 'layout-edited')
      await page.getByLabel('每页行数', { exact: true }).scrollIntoViewIfNeeded()
      assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isEnabled(), true)
      const footer = await page.locator('.page-bar').boundingBox()
      assert.ok(footer.y >= 0 && footer.y + footer.height <= height, 'pagination is outside the window')
      const editor = page.getByRole('textbox', { name: 'SQL 编辑器', exact: true })
      await editor.scrollIntoViewIfNeeded()
      await editor.click()
      assert.equal(await editor.evaluate(el => el.contains(document.activeElement)), true)
      assert.deepEqual(await page.evaluate(() => window.workbenchLayout.unexpected), [])
      await first.scrollIntoViewIfNeeded()
      await page.screenshot({ path: path.join(output, `workbench-${width}x${height}.png`) })
    })
  }
}
