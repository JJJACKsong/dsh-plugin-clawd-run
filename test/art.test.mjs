/** Clawd 快跑：美术图集与客户端内嵌一致性，纯 Node 测试。 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const svg = readFileSync(join(root, 'assets', 'scene-atlas.svg'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'assets', 'scene-atlas.json'), 'utf8'))

assert.equal(manifest.tiles.length, 12, '应有 12 个原创像素道具')
assert.equal(manifest.width, 192)
assert.equal(manifest.height, 144)
assert.match(svg, /shape-rendering="crispEdges"/)
assert.ok((svg.match(/<rect /g) || []).length > 100, '图集未补全细节')
for (const sector of ['server', 'cooling', 'core']) {
  const tiles = manifest.tiles.filter((tile) => tile.sector === sector)
  assert.equal(tiles.length, 4, sector + ' 需要四种道具')
}
for (const tile of manifest.tiles) {
  assert.equal(tile.width, 48)
  assert.equal(tile.height, 48)
  assert.ok(tile.x >= 0 && tile.x + tile.width <= manifest.width)
  assert.ok(tile.y >= 0 && tile.y + tile.height <= manifest.height)
}
const match = src.match(/    const SCENE_ATLAS_SVG = ("[^\n]+")\n/)
assert.ok(match, '客户端内嵌可离线加载的原创图集')
assert.equal(JSON.parse(match[1]), svg, '内嵌 SVG 与可编辑资产一致')
assert.match(src, /drawMapExtraProps\(ctx, worldX\)/, '地图调用图集')
assert.match(src, /drawPlayfieldContrast\(ctx\)/, '操作带背景降对比')
assert.match(src, /#ffca55/, '跳跃障碍采用专属黄橙色')
assert.match(src, /#ff2d45/, '滑铲激光采用专属纯红色')
assert.match(src, /#ffc44d/, '金币采用专属金色')
console.log('clawd-run art: atlas 12/12 + contrast + hazards + gold tokens passed')
