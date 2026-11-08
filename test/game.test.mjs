/**
 * Clawd 快跑规则内核单测。
 *
 * 直接从 lib/client.js 抽出 `#region game-core` 段（纯函数，不依赖 React/DOM），
 * 用 new Function 装成模块跑——测的是真正上线的那段代码。
 *
 * 跑法：node test/game.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
const begin = source.indexOf('// ── #region game-core')
const end = source.indexOf('// #endregion game-core')
assert.ok(begin !== -1 && end > begin, 'game-core 标记存在')
const region = source.slice(begin, end)

const api = new Function(region + `
  return {
    VIEW_W, VIEW_H, GROUND_Y, PLAYER_X, PLAYER_W, PLAYER_H, SLIDE_H,
    GRAVITY, JUMP_V, SLIDE_TIME, START_SPEED, MAX_SPEED,
    START_GAP, MAX_GAP, GAP_DRAIN, TOKEN_GAP, HIT_GAP, HIT_INVULN,
    TOKEN_SCORE, TOKEN_SIZE, MILESTONE, LOW_W, LOW_H, HIGH_W, HIGH_TOP, HIGH_BOTTOM,
    nextRandom, randomSeed, clamp, speedFor, sectorOf, mapSegmentOf, sectorBlendOf, createObstaclePattern,
    createObstacle, createTokenPattern, createObstacleTokens, createBonusTokens,
    tokenClearOfObstacle, tokensClearOfObstacles, jumpGuideLead, slideGuideLead,
    createGame, stepPlayer, stepGame,
    snapshotGame, restoreGame,
  }
`)()

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok  ' + name)
  } catch (error) {
    console.error('  FAIL  ' + name)
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

function running(game) { return { ...game, status: 'running' } }

function quiet(game) {
  return {
    ...game,
    obstacles: [],
    tokensList: [],
    spawnTimer: 999,
    tokenTimer: 999,
  }
}

function assertFinite(value, label) {
  assert.ok(Number.isFinite(value), label + ' 不是有限数字：' + value)
}

// ── 1. 基础 ────────────────────────────────────────────────────────────────
test('速度随距离增长且封顶', () => {
  assert.equal(api.speedFor(0), api.START_SPEED)
  assert.ok(api.speedFor(500) > api.speedFor(0))
  assert.equal(api.speedFor(99999), api.MAX_SPEED)
  assert.equal(api.VIEW_W, 400)
  assert.equal(api.VIEW_H, 225)
})

test('开一局：ready、有初始 token、达里奥距离到位', () => {
  const game = api.createGame({ seed: 42 })
  assert.equal(game.status, 'ready')
  assert.equal(game.score, 0)
  assert.equal(game.tokens, 0)
  assert.equal(game.distance, 0)
  assert.equal(game.gap, api.START_GAP)
  assert.equal(game.speed, api.START_SPEED)
  assert.equal(game.player.y, 0)
  assert.equal(game.player.sliding, false)
  assert.ok(game.tokensList.length >= 7, '开局画面里应该有 token：' + game.tokensList.length)
  assert.ok(Array.isArray(game.bubbles) && game.bubbles.length > 0)
})

test('同一个 seed 开局完全可复现', () => {
  const a = api.createGame({ seed: 20261107 })
  const b = api.createGame({ seed: 20261107 })
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

test('非 running 状态不推进', () => {
  const game = api.createGame({ seed: 3 })
  const result = api.stepGame(game, 1 / 60, { jump: true })
  assert.equal(result.game, game)
  assert.deepEqual(result.events, [])
})

// ── 2. 跳跃 / 滑铲 ─────────────────────────────────────────────────────────
test('跳跃：离地、上升、再落地', () => {
  let game = running(api.createGame({ seed: 7 }))
  const jumped = api.stepGame(game, 1 / 60, { jump: true })
  assert.ok(jumped.events.includes('jump'))
  assert.ok(jumped.game.player.y < 0)
  assert.ok(jumped.game.player.vy < 0)
  game = jumped.game
  let ticks = 0
  while (game.player.y < 0 && ticks < 200) {
    game = api.stepGame(game, 1 / 60, {}).game
    ticks += 1
  }
  assert.ok(ticks < 200, '应该在合理时间内落地')
  assert.equal(game.player.y, 0)
  assert.equal(game.player.vy, 0)
})

test('滑铲持续一会儿后自动结束', () => {
  let game = running(api.createGame({ seed: 8 }))
  const slid = api.stepGame(game, 1 / 60, { slide: true })
  assert.ok(slid.events.includes('slide'))
  assert.equal(slid.game.player.sliding, true)
  game = slid.game
  for (let i = 0; i < 60 && game.player.sliding; i += 1) {
    game = api.stepGame(game, 1 / 60, {}).game
  }
  assert.equal(game.player.sliding, false)
})

test('空中按下滑铲会快速下落，不会卡住', () => {
  let game = running(api.createGame({ seed: 9 }))
  game = quiet(game)
  game.player = { ...game.player, y: -60, vy: -100 }
  const result = api.stepGame(game, 1 / 60, { slide: true })
  assert.ok(result.game.player.vy > 0, '应该被改成向下')
})

test('Token 拱线与滑线绕开障碍、空闲段有四种图案', () => {
  for (const speed of [170, 218, 290, 360]) {
    for (const type of ['low', 'high']) {
      const obstacle = { id: 1, type, x: 300 }
      const got = api.createObstacleTokens(123, 1, obstacle, speed).tokens
      assert.equal(got.length, type === 'low' ? 8 : 6)
      assert.ok(got.every((t) => t.kind === 'guide'))
      assert.ok(got.every((t) => api.tokenClearOfObstacle(t, obstacle)))
      if (type === 'low') {
        assert.ok(new Set(got.map((t) => t.y)).size >= 5)
        assert.ok(got[0].y > got[3].y)
      } else {
        assert.ok(got.every((t) => t.y === api.GROUND_Y - 9))
        assert.ok(got.slice(0, 3).every((t) => t.x < obstacle.x - 15))
        assert.ok(got.slice(3).every((t) => t.x > obstacle.x + api.HIGH_W + 15))
      }
    }
  }
  for (const name of ['heart', 'diamond', 'arrow', 'paw']) {
    const tokens = api.createTokenPattern(7, 1, 180, name).tokens
    assert.ok(tokens.length >= 8, name + ' 不完整')
    assert.ok(tokens.every((t) => t.kind === 'bonus' && t.formation === name))
    assert.ok(new Set(tokens.map((t) => t.y)).size >= 4)
  }
  assert.equal(api.createTokenPattern(999, 1, 200, 'wave').tokens.length, 7)
})

test('照路线提示跳滑，在四档速度下均能收齐引导 Token', () => {
  for (const distance of [0, 400, 1000, 1800]) {
    const speed = api.speedFor(distance)
    for (const type of ['low', 'high']) {
      const obstacle = { id: 1, type, x: 360, sector: 0 }
      const guide = api.createObstacleTokens(18, 2, obstacle, speed)
      let game = {
        ...api.createGame({ seed: 1 }), status: 'running', distance, gap: api.MAX_GAP,
        spawnTimer: 999, tokenTimer: 999, obstacles: [obstacle], tokensList: guide.tokens,
      }
      let triggered = false, hits = 0, picked = 0
      for (let i = 0; i < 200; i += 1) {
        const lead = type === 'low' ? api.jumpGuideLead(speed) : api.slideGuideLead(speed)
        const press = !triggered && game.obstacles.length > 0 &&
          game.obstacles[0].x - lead <= api.PLAYER_X + 3
        if (press) triggered = true
        const outcome = api.stepGame(game, 1 / 60, press ? { [type === 'low' ? 'jump' : 'slide']: true } : {})
        hits += outcome.events.filter((e) => e === 'hit').length
        picked += outcome.events.filter((e) => e === 'token').length
        game = outcome.game
        if (game.obstacles.length === 0) break
      }
      assert.ok(triggered)
      assert.equal(hits, 0, type + ' @ ' + speed)
      assert.equal(picked, guide.tokens.length, type + ' @ ' + speed)
    }
  }
})

test('安全图案只放在组间，独立自由刷币不再干扰障碍', () => {
  const pattern = { restTime: 1.9 }
  let count = 0
  const names = new Set()
  for (const type of ['low', 'high']) {
    for (const speed of [170, 260, 360]) {
      for (let seed = 0; seed < 70; seed += 1) {
        const obstacle = { id: 1, type, x: 440, distance: 250 }
        const tokens = api.createBonusTokens(seed, 20, pattern, obstacle, speed).tokens
        count += tokens.length
        for (const t of tokens) {
          names.add(t.formation)
          assert.ok(api.tokenClearOfObstacle(t, obstacle))
          assert.ok(api.tokenClearOfObstacle(t, { type: 'high', x: obstacle.x + speed * pattern.restTime }))
        }
      }
    }
  }
  assert.ok(count >= 100)
  assert.ok(names.size >= 3)
  const game = quiet(running(api.createGame({ seed: 4 })))
  game.tokenTimer = -5
  assert.equal(api.stepGame(game, 1 / 60, {}).game.tokensList.length, 0)
})

test('批量长跑 16 种种子：Token 无视觉重叠，图案多样，数量有界', () => {
  const seen = new Set()
  let highest = 0
  for (let seed = 1; seed <= 16; seed += 1) {
    let game = running(api.createGame({ seed }))
    for (let i = 0; i < 1800; i += 1) {
      game = api.stepGame({ ...game, gap: api.MAX_GAP }, 1 / 60, {}).game
      assert.equal(game.status, 'running')
      highest = Math.max(highest, game.tokensList.length)
      for (const token of game.tokensList) {
        assert.ok(game.obstacles.every((o) => api.tokenClearOfObstacle(token, o)),
          '障碍重合 seed ' + seed + ' tick ' + i)
        if (token.kind === 'bonus') seen.add(token.formation)
      }
    }
  }
  assert.ok(highest <= 80, '存档 Token 容量')
  for (const name of ['heart', 'diamond', 'arrow', 'paw']) assert.ok(seen.has(name))
})

test('旧档兼容，远处三连障碍与图案 token 不发生坐标裁剪', () => {
  const farX = api.VIEW_W + 1000
  const game = {
    ...api.createGame({ seed: 101 }), status: 'running', spawnTimer: 5.3,
    obstacles: [{ id: 999, type: 'high', x: farX, sector: 2 }],
    tokensList: [{ id: 1001, x: farX + 50, y: 125, phase: 0, kind: 'bonus', formation: 'heart' }],
  }
  const restored = api.restoreGame(api.snapshotGame(game))
  assert.equal(restored.obstacles[0].x, farX)
  assert.equal(restored.tokensList[0].x, farX + 50)
  assert.equal(restored.tokensList[0].formation, 'heart')
  assert.equal(restored.spawnTimer, 5.3)
  const legacy = api.restoreGame({
    player: { y: 0 }, tokensList: [{ id: 1, x: 300, y: 142, phase: 0 }],
  })
  assert.ok(legacy && legacy.tokensList.length === 1)
})

test('区域划分与关卡图案间距合理', () => {
  assert.equal(api.sectorOf(0), 1)
  assert.equal(api.sectorOf(299), 1)
  assert.equal(api.sectorOf(300), 2)
  assert.equal(api.sectorOf(900), 4)
  for (const [distance, speed] of [[0, 170], [200, 200], [500, 240], [1000, 320]]) {
    for (let seed = 1; seed <= 20; seed += 1) {
      const pattern = api.createObstaclePattern(seed, distance, speed)
      assert.ok(pattern.obstacles.length >= 1 && pattern.obstacles.length <= 3)
      for (const obstacle of pattern.obstacles) {
        assert.ok(obstacle.type === 'low' || obstacle.type === 'high')
        assert.ok(Number.isFinite(obstacle.x) && obstacle.x > api.VIEW_W)
      }
      for (let i = 1; i < pattern.obstacles.length; i += 1) {
        const gap = pattern.obstacles[i].x - pattern.obstacles[i - 1].x
        assert.ok(gap >= speed * 0.8, '障碍之间至少留 0.8 秒动作时间：' + gap)
      }
    }
  }
})

test('地图每 75m 分段，循环后调整部分场景顺序', () => {
  assert.equal(api.mapSegmentOf(0).kind, 'service-aisle')
  assert.equal(api.mapSegmentOf(76).kind, 'rack-gallery')
  assert.equal(api.mapSegmentOf(151).kind, 'checkpoint')
  assert.equal(api.mapSegmentOf(251).kind, 'airlock')
  assert.equal(api.mapSegmentOf(300).sector, 1)
  assert.equal(api.mapSegmentOf(375).kind, 'reservoir')
  assert.equal(api.mapSegmentOf(600).sector, 2)
  assert.equal(api.mapSegmentOf(900).sector, 0)
  assert.equal(api.mapSegmentOf(975).kind, 'checkpoint')
})

test('每 300m 边界前后 24m 背景渐变', () => {
  assert.equal(api.sectorBlendOf(270), null)
  const before = api.sectorBlendOf(278)
  const middle = api.sectorBlendOf(300)
  const after = api.sectorBlendOf(322)
  assert.equal(before.from, 0)
  assert.equal(after.to, 1)
  assert.ok(before.mix < 0.1)
  assert.ok(Math.abs(middle.mix - 0.5) < 0.001)
  assert.ok(after.mix > 0.9)
  assert.equal(api.sectorBlendOf(326), null)
})

test('地图区域障碍差异与出口缓冲正确', () => {
  const centers = [90, 390, 690]
  for (let sector = 0; sector < 3; sector += 1) {
    const kinds = new Set()
    for (let seed = 0; seed < 60; seed += 1) {
      const pattern = api.createObstaclePattern(seed, centers[sector], 250)
      assert.equal(pattern.sector, sector)
      assert.ok(pattern.restTime >= 0.95)
      for (const obstacle of pattern.obstacles) kinds.add(obstacle.type)
    }
    assert.ok(kinds.has('low') && kinds.has('high'))
  }
  for (const distance of [240, 550, 880, 1140]) {
    for (let seed = 0; seed < 80; seed += 1) {
      const pattern = api.createObstaclePattern(seed, distance, 300)
      assert.equal(pattern.obstacles.length, 1)
      assert.ok(pattern.restTime >= 1.35)
    }
  }
})

test('暂停恢复不压缩三连障碍间隔，旧版地图数据兼容', () => {
  const game = { ...api.createGame({ seed: 180 }), status: 'running', spawnTimer: 3.45,
    obstacles: [{ id: 41, type: 'low', x: 350 }] }
  const snap = api.snapshotGame(game)
  assert.equal(snap.spawnTimer, 3.45)
  const restored = api.restoreGame(snap)
  assert.equal(restored.spawnTimer, 3.45)
  assert.equal(restored.obstacles[0].sector, 0)
  assert.equal(api.restoreGame({ player: { y: 0 }, spawnTimer: 0 }).spawnTimer, 0)
})

// ── 3. 障碍碰撞 ────────────────────────────────────────────────────────────
test('低障碍：不跳会撞、跳起来能过', () => {
  let base = running(api.createGame({ seed: 11 }))
  base = quiet(base)
  const hit = api.stepGame({ ...base, obstacles: [{ id: 1, type: 'low', x: api.PLAYER_X }] }, 1 / 60, {})
  assert.ok(hit.events.includes('hit'))
  assert.ok(hit.game.gap < api.START_GAP)
  assert.equal(hit.game.obstacles.length, 0, '撞碎的障碍应该移除')

  const cleared = api.stepGame(
    { ...base, player: { ...base.player, y: -30 }, obstacles: [{ id: 2, type: 'low', x: api.PLAYER_X }] },
    1 / 60,
    {},
  )
  assert.ok(!cleared.events.includes('hit'))
  assert.equal(cleared.game.obstacles.length, 1)
})

test('高横幅：站着撞、滑铲能过、跳起来也会撞', () => {
  let base = running(api.createGame({ seed: 12 }))
  base = quiet(base)
  const standing = api.stepGame({ ...base, obstacles: [{ id: 1, type: 'high', x: api.PLAYER_X }] }, 1 / 60, {})
  assert.ok(standing.events.includes('hit'))

  const sliding = api.stepGame(
    {
      ...base,
      player: { ...base.player, sliding: true, slideTimer: api.SLIDE_TIME },
      obstacles: [{ id: 2, type: 'high', x: api.PLAYER_X }],
    },
    1 / 60,
    {},
  )
  assert.ok(!sliding.events.includes('hit'))

  const jumping = api.stepGame(
    { ...base, player: { ...base.player, y: -30 }, obstacles: [{ id: 3, type: 'high', x: api.PLAYER_X }] },
    1 / 60,
    {},
  )
  assert.ok(jumping.events.includes('hit'), '高横幅不能靠跳过去')
})

test('撞到障碍后有短暂无敌，不会连撞同帧多次', () => {
  let base = running(api.createGame({ seed: 13 }))
  base = quiet(base)
  const first = api.stepGame(
    { ...base, obstacles: [{ id: 1, type: 'low', x: api.PLAYER_X }, { id: 2, type: 'low', x: api.PLAYER_X + 2 }] },
    1 / 60,
    {},
  )
  assert.equal(first.events.filter((event) => event === 'hit').length, 1, '同一帧最多掉一次')
  assert.ok(first.game.player.invuln > 0)
})

// ── 4. token / 追逐 ────────────────────────────────────────────────────────
test('吃到 token：加 token 数、拉距离、加分', () => {
  let base = running(api.createGame({ seed: 14 }))
  base = quiet(base)
  const centerY = api.GROUND_Y - api.PLAYER_H / 2
  const result = api.stepGame(
    { ...base, tokensList: [{ id: 1, x: api.PLAYER_X, y: centerY, phase: 0 }] },
    1 / 60,
    {},
  )
  assert.ok(result.events.includes('token'))
  assert.equal(result.game.tokens, 1)
  assert.ok(result.game.gap > api.START_GAP - 1, '吃 token 应该拉回一点距离')
  assert.ok(result.game.score >= api.TOKEN_SCORE)
  assert.equal(result.game.tokensList.length, 0)
})

test('达里奥会慢慢逼近，距离清零就抓住', () => {
  let game = quiet(running(api.createGame({ seed: 15 })))
  game = { ...game, gap: 0.02 }
  const result = api.stepGame(game, 1 / 60, {})
  assert.equal(result.game.gap, 0)
  assert.equal(result.game.status, 'over')
  assert.ok(result.events.includes('caught'))
})

test('距离里程碑抛 milestone 事件', () => {
  let game = quiet(running(api.createGame({ seed: 16 })))
  game = { ...game, distance: api.MILESTONE - 0.01 }
  const result = api.stepGame(game, 0.05, {})
  assert.ok(result.game.distance >= api.MILESTONE)
  assert.ok(result.events.includes('milestone'))
})

// ── 5. 刷怪 ────────────────────────────────────────────────────────────────
test('跑几秒会刷出障碍和 token，数量有界', () => {
  let game = running(api.createGame({ seed: 17 }))
  let sawObstacle = false
  let sawToken = true
  for (let i = 0; i < 300; i += 1) {
    const result = api.stepGame(game, 1 / 60, { jump: i % 90 === 0 })
    game = result.game
    if (game.obstacles.length > 0) sawObstacle = true
    if (game.tokensList.length > 0) sawToken = true
    assert.ok(game.obstacles.length <= 12, '障碍数量有界')
    assert.ok(game.tokensList.length <= 80, 'token 数量有界')
    if (game.status !== 'running') break
  }
  assert.ok(sawObstacle, '应该刷出障碍')
  assert.ok(sawToken, '应该有 token')
})

// ── 6. 存档 ────────────────────────────────────────────────────────────────
test('存档：运行中存成暂停，读回来接着跑', () => {
  let game = running(api.createGame({ seed: 18 }))
  for (let i = 0; i < 20; i += 1) game = api.stepGame(game, 1 / 60, { jump: i % 10 === 0 }).game
  const snapshot = api.snapshotGame(game)
  assert.ok(snapshot)
  assert.equal(snapshot.status, 'paused')
  const restored = api.restoreGame(snapshot)
  assert.ok(restored)
  assert.equal(restored.status, 'paused')
  assert.equal(restored.tokens, game.tokens)
  assert.ok(Math.abs(restored.distance - game.distance) < 0.001)
  assert.ok(Math.abs(restored.gap - game.gap) < 0.001)
  assert.equal(restored.tokensList.length, game.tokensList.length)
  assert.equal(restored.obstacles.length, game.obstacles.length)
})

test('坏档丢弃 / 缺字段给默认值', () => {
  assert.equal(api.restoreGame(null), null)
  assert.equal(api.restoreGame({}), null)
  assert.equal(api.restoreGame({ player: { y: 0 }, tokensList: 'nope' }), null)
  assert.equal(api.restoreGame({ player: { y: 0 } }).status, 'paused')
  const minimal = api.restoreGame({ player: { y: 0 }, gap: 50, distance: 12, tokens: 2 })
  assert.ok(minimal)
  assert.equal(minimal.gap, 50)
  assert.equal(minimal.distance, 12)
  assert.equal(minimal.tokens, 2)
  assert.equal(minimal.obstacles.length, 0)
  assert.equal(minimal.score, 2 * api.TOKEN_SCORE + 12)
})

// ── 7. 长跑不变量 ──────────────────────────────────────────────────────────
test('随机跑 1200 帧：数值有界、状态自洽、不崩', () => {
  let game = running(api.createGame({ seed: 0x20261107 }))
  let ticks = 0
  let sawJump = false
  let sawSlide = false
  let sawToken = false
  let sawHit = false
  while (game.status === 'running' && ticks < 1200) {
    const input = {
      jump: ticks % 75 === 0,
      slide: ticks % 110 === 0,
    }
    const result = api.stepGame(game, 1 / 60, input)
    game = result.game
    ticks += 1
    if (result.events.includes('jump')) sawJump = true
    if (result.events.includes('slide')) sawSlide = true
    if (result.events.includes('token')) sawToken = true
    if (result.events.includes('hit')) sawHit = true
    assert.ok(game.tokens >= 0)
    assert.ok(game.distance >= 0)
    assert.ok(game.gap >= 0 && game.gap <= api.MAX_GAP + 0.001)
    assert.ok(game.speed >= api.START_SPEED && game.speed <= api.MAX_SPEED)
    assert.ok(game.player.y <= 0 && game.player.y > -140)
    assertFinite(game.player.y, 'player.y')
    assertFinite(game.player.vy, 'player.vy')
    assertFinite(game.distance, 'distance')
    assertFinite(game.gap, 'gap')
    for (const obstacle of game.obstacles) assertFinite(obstacle.x, 'obstacle.x')
    for (const token of game.tokensList) {
      assertFinite(token.x, 'token.x')
      assertFinite(token.y, 'token.y')
    }
  }
  assert.ok(ticks > 100)
  assert.ok(sawJump && sawSlide, '长跑里应该既跳又滑')
  assert.ok(sawToken || sawHit, '长跑里至少吃到 token 或撞到东西')
})

test('同样的 seed + 同样的输入，结果完全一致', () => {
  const inputs = Array.from({ length: 160 }, (_, index) => ({
    jump: index % 40 === 0,
    slide: index % 53 === 0,
  }))
  let a = running(api.createGame({ seed: 999 }))
  let b = running(api.createGame({ seed: 999 }))
  for (const input of inputs) {
    a = api.stepGame(a, 1 / 60, input).game
    b = api.stepGame(b, 1 / 60, input).game
  }
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

console.log('')
console.log('clawd-run core: ' + passed + ' 项通过')
if (process.exitCode) {
  console.error('有失败项')
} else {
  console.log('全部通过')
}
