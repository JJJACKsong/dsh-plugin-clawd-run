/**
 * dsh-plugin-clawd-run — Clawd 快跑（浏览器半，手写 bundle，无构建步骤）。
 *
 * 横版像素跑酷：Clawd 自动向前跑，玩家只负责跳跃 / 滑铲，捡 token 拉开和达里奥的距离。
 * 装了游戏厅则向 `window.__dshArcade` 登记；没装则回退独立侧栏图标 + 主面板。
 *
 * 状态只写 localStorage（dshclawd.*），不碰会话 / 工作区 / 网络。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-clawd-run',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-clawd-run'
    const PANEL_ID = 'dsh-clawd-run'
    const LS_GAME = 'dshclawd.game.v1'
    const LS_BEST = 'dshclawd.best.v1'
    const LS_SOUND = 'dshclawd.sound.v1'

    // ── #region game-core（纯函数，与 React / DOM 无关；单测直接抽这一段） ──
    /** 画布与赛道常量。 */
    const VIEW_W = 400
    const VIEW_H = 225
    const GROUND_Y = 180
    const PLAYER_X = 110
    // 碰撞盒贴着身体：宽 22（身体 24，手臂不算），站立高 24、滑铲高 12；
    // 触角纯装饰，不参与碰撞，避免「看起来躲开了却被判中」。
    const PLAYER_W = 22
    const PLAYER_H = 24
    const SLIDE_H = 12
    const GRAVITY = 1500
    const JUMP_V = -440
    const SLIDE_TIME = 0.7
    const START_SPEED = 170
    const MAX_SPEED = 360
    const START_GAP = 92
    const MAX_GAP = 150
    const GAP_DRAIN = 3
    const TOKEN_GAP = 2
    const HIT_GAP = 30
    const HIT_INVULN = 0.9
    const TOKEN_SCORE = 10
    const TOKEN_SIZE = 10
    const TOKEN_CLEARANCE = 8
    const TOKEN_MAX_X = VIEW_W + MAX_SPEED * 8
    const MILESTONE = 250
    const SECTOR_LENGTH = 300
    const MAP_CHUNK_LENGTH = 75
    const SECTOR_BLEND_HALF = 24
    const LOW_W = 30
    const LOW_H = 22
    const HIGH_W = 34
    const HIGH_TOP = GROUND_Y - 72
    const HIGH_BOTTOM = GROUND_Y - 18

    /** mulberry32 一步：返回 [0,1) 与下一个状态，状态可持久化。 */
    function nextRandom(state) {
      let a = (state + 0x6d2b79f5) >>> 0
      let t = Math.imul(a ^ (a >>> 15), a | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: a }
    }
    function randomSeed() { return (Math.random() * 0x100000000) >>> 0 }
    function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
    function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value) }

    function speedFor(distance) {
      return Math.min(MAX_SPEED, START_SPEED + Math.max(0, Number(distance) || 0) * 0.12)
    }

    function createObstacle(rngState, id, x) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      const type = rand() < 0.55 ? 'low' : 'high'
      return {
        obstacle: { id, type, x: isFiniteNumber(x) ? x : VIEW_W + 40 },
        rngState: state,
      }
    }

    /** 距离 → 区域编号（每 300m 一个区域，视觉/节奏跟着变）。 */
    function sectorOf(distance) {
      return 1 + Math.floor(Math.max(0, Number(distance) || 0) / SECTOR_LENGTH)
    }

    /** 四个 75m 片段组成 300m 场景；循环后调换中间两段的主题。 */
    function mapSegmentOf(distance) {
      const d = Math.max(0, Number(distance) || 0)
      const index = Math.floor(d / SECTOR_LENGTH)
      const sector = index % 3
      const offset = d - index * SECTOR_LENGTH
      const slot = Math.min(3, Math.floor(offset / MAP_CHUNK_LENGTH))
      const names = [
        ['service-aisle', 'rack-gallery', 'checkpoint', 'airlock'],
        ['pipeway', 'reservoir', 'fan-gallery', 'airlock'],
        ['power-gallery', 'conduit', 'containment', 'airlock'],
      ]
      const alternate = Math.floor(index / 3) % 2 === 1 && (slot === 1 || slot === 2)
      return { sector, slot, kind: names[sector][alternate ? 3 - slot : slot], index, offset }
    }

    /** 边界前后 24m 渐隐渐显，不再 300m 突然换整张场景。 */
    function sectorBlendOf(distance) {
      const d = Math.max(0, Number(distance) || 0)
      const n = Math.round(d / SECTOR_LENGTH)
      if (n < 1) return null
      const delta = d - n * SECTOR_LENGTH
      if (Math.abs(delta) >= SECTOR_BLEND_HALF) return null
      const p = (delta + SECTOR_BLEND_HALF) / (2 * SECTOR_BLEND_HALF)
      const mix = p * p * (3 - 2 * p)
      return { from: (n - 1) % 3, to: n % 3, mix }
    }

    /**
     * 关卡图案：一次生成 1~3 个障碍，按动作时间留出可完成间距。
     * tier 随距离上升：单障碍 → 低高组合 → 三连交替。
     */
    function createObstaclePattern(rngState, distance, speed) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      const tier = distance < 150 ? 0 : distance < 400 ? 1 : distance < 800 ? 2 : 3
      const segment = mapSegmentOf(distance)
      // 三个区域分别偏向跳跃、滑铲和交替操作；出口段单障碍恢复节奏。
      const catalogs = [
        [['low'], ['low'], ['high'], ['low', 'high'], ['high', 'low'], ['low', 'high', 'low']],
        [['high'], ['high'], ['low'], ['high', 'low'], ['low', 'high'], ['high', 'low', 'high']],
        [['low'], ['high'], ['low'], ['high', 'low'], ['low', 'high'], ['low', 'high', 'low'], ['high', 'low', 'high']],
      ]
      const catalog = catalogs[segment.sector]
      const limit = tier === 0 || segment.slot === 3 ? 3 : tier === 1 || segment.slot === 0 ? 5 : catalog.length
      const kinds = catalog[Math.floor(rand() * limit)]
      const gapTime = 0.90 + rand() * 0.22
      const gapPx = Math.round(speed * gapTime)
      const obstacles = []
      let x = VIEW_W + 40
      for (const kind of kinds) {
        obstacles.push({ type: kind, x })
        x += gapPx
      }
      const restTime = (segment.slot === 3 ? 1.65 : 1.25) + rand() * 0.30
      return { obstacles, gapTime, endOffset: gapPx * (kinds.length - 1),
        restTime, sector: segment.sector, rngState: state }
    }

    /** 金币在跑道上的纯函数安全区：含 5px 币半径 + 8px 视觉留白。 */
    function tokenClearOfObstacle(token, obstacle) {
      const edge = TOKEN_SIZE / 2 + TOKEN_CLEARANCE
      const left = obstacle.type === 'low' ? obstacle.x - 5 : obstacle.x - 9
      const right = obstacle.type === 'low' ? obstacle.x + LOW_W + 5 : obstacle.x + HIGH_W + 9
      const top = obstacle.type === 'low' ? GROUND_Y - LOW_H - 6 : HIGH_TOP - 12
      const bottom = obstacle.type === 'low' ? GROUND_Y + 3 : GROUND_Y + 3
      return token.x + edge < left || token.x - edge > right ||
        token.y + edge < top || token.y - edge > bottom
    }

    function tokensClearOfObstacles(tokens, obstacles) {
      return tokens.filter((token) => obstacles.every((obstacle) => tokenClearOfObstacle(token, obstacle)))
    }

    /** 跳跃预示点依据物理抛物线：玩家在首币处起跳可以沿点阵捡币并避障。 */
    function jumpGuideLead(speed) { return clamp(speed * 0.23, 42, 84) }
    function slideGuideLead(speed) { return clamp(speed * 0.28, 58, 94) }

    const BONUS_GLYPHS = {
      // 心形、菱形、右向箭头、Clawd 爪印：只有安全间隙允许生成。
      heart: ['.##.##.', '#..#..#', '#.....#', '.#...#.', '..#.#..', '...#...'],
      diamond: ['...#...', '..#.#..', '.#...#.', '#.....#', '.#...#.', '..#.#..', '...#...'],
      arrow: ['...#...', '....#..', '#######', '....#..', '...#...'],
      paw: ['.#.#.#.', '.......', '..###..', '.#####.', '..###..'],
    }

    /** 空白路段的糖豆图案。旧的图案名字仍可显式调用以兼容已有测试。 */
    function createTokenPattern(rngState, nextId, startX, kind) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      let id = nextId
      const tokens = []
      const all = ['heart', 'diamond', 'arrow', 'paw']
      const choice = kind || all[Math.floor(rand() * all.length)]
      const put = (x, y) => {
        tokens.push({ id: id++, x, y, phase: rand() * Math.PI * 2, kind: 'bonus', formation: choice })
      }
      if (Object.prototype.hasOwnProperty.call(BONUS_GLYPHS, choice)) {
        const glyph = BONUS_GLYPHS[choice]
        const y0 = GROUND_Y - (glyph.length >= 7 ? 100 : glyph.length === 6 ? 92 : 86)
        for (let row = 0; row < glyph.length; row += 1) {
          for (let col = 0; col < glyph[row].length; col += 1) {
            if (glyph[row][col] === '#') put(startX + col * 12, y0 + row * 12)
          }
        }
      } else if (choice === 'wave') {
        for (let i = 0; i < 7; i += 1) put(startX + i * 18, GROUND_Y - 32 + Math.sin(i * 0.9) * 14)
      } else if (choice === 'stairUp' || choice === 'stairDown') {
        for (let i = 0; i < 5; i += 1) put(startX + i * 20, GROUND_Y - (choice === 'stairUp' ? 18 + i * 9 : 54 - i * 9))
      } else if (choice === 'zigzag') {
        for (let i = 0; i < 6; i += 1) put(startX + i * 18, i % 2 === 0 ? GROUND_Y - 24 : GROUND_Y - 48)
      } else if (choice === 'rows') {
        for (let i = 0; i < 4; i += 1) { put(startX + i * 20, GROUND_Y - 28); put(startX + i * 20, GROUND_Y - 48) }
      } else {
        for (const [dx, dy] of [[24, -34], [14, -44], [34, -44], [24, -54], [24, -64]]) {
          put(startX + dx, GROUND_Y + dy)
        }
      }
      const width = Math.max(0, ...tokens.map((token) => token.x - startX))
      return { tokens, rngState: state, nextId: id, width, kind: choice }
    }

    /** 收集轨迹与操作匹配；激光门中间刻意留白，避免币压在危险光束上。 */
    function createObstacleTokens(rngState, nextId, obstacle, speed = START_SPEED) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      let id = nextId
      const tokens = []
      const guide = obstacle.type === 'low' ? 'jump' : 'slide'
      const put = (x, y) => tokens.push({
        id: id++, x: Math.round(x), y: Math.round(y),
        phase: rand() * Math.PI * 2, kind: 'guide', formation: guide,
      })
      if (obstacle.type === 'low') {
        const lead = jumpGuideLead(speed)
        for (const t of [0, 0.08, 0.16, 0.24, 0.32, 0.40, 0.48, 0.56]) {
          // 站立玩家中心约为 GROUND_Y-12。
          const rise = JUMP_V * t + GRAVITY * t * t / 2
          put(obstacle.x - lead + speed * t, GROUND_Y - PLAYER_H / 2 + rise)
        }
      } else {
        const lead = slideGuideLead(speed)
        for (const k of [1, 0.73, 0.46]) put(obstacle.x - lead * k, GROUND_Y - 9)
        for (const step of [30, 49, 68]) put(obstacle.x + HIGH_W + step, GROUND_Y - 9)
      }
      return { tokens: tokensClearOfObstacles(tokens, [obstacle]), rngState: state, nextId: id }
    }

    /** 图案只出现在障碍组之间的实际空窗：预留前后动作轨迹与下一组的提前提示。 */
    function createBonusTokens(rngState, nextId, pattern, lastObstacle, speed) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      if (rand() > (mapSegmentOf(lastObstacle.distance ?? 0).slot === 3 ? 0.90 : 0.58)) {
        return { tokens: [], rngState: state, nextId }
      }
      const variants = ['heart', 'diamond', 'arrow', 'paw']
      const choice = variants[Math.floor(rand() * variants.length)]
      // 先在原点生成模板；再以实际预留安全区定位。
      const template = createTokenPattern(state, nextId, 0, choice)
      state = template.rngState
      const lastTail = lastObstacle.type === 'low'
        ? speed * 0.33 : HIGH_W + 80
      const safeLeft = lastObstacle.x + lastTail + TOKEN_CLEARANCE + 10
      const nextLeadingX = lastObstacle.x + speed * pattern.restTime - slideGuideLead(speed)
      const safeRight = nextLeadingX - TOKEN_CLEARANCE - 16
      if (template.width + 12 > safeRight - safeLeft) {
        return { tokens: [], rngState: state, nextId }
      }
      const deltaX = Math.round((safeLeft + safeRight - template.width) / 2)
      return {
        tokens: template.tokens.map((token) => ({ ...token, x: token.x + deltaX })),
        rngState: state, nextId: template.nextId,
      }
    }

    function createGame(options) {
      const opts = options || {}
      let rngState = Number.isFinite(opts.seed) ? (opts.seed >>> 0) : randomSeed()
      let nextId = 1
      const player = { y: 0, vy: 0, sliding: false, slideTimer: 0, invuln: 0, anim: 0 }
      const tokensList = []
      // 开场只展示一组完整心形；不再把两组随机 token 堆在一起。
      const opening = createTokenPattern(rngState, nextId, 198, 'heart')
      rngState = opening.rngState
      nextId = opening.nextId
      for (const token of opening.tokens) tokensList.push(token)
      const bubbles = []
      for (let i = 0; i < 20; i += 1) {
        const a = nextRandom(rngState); rngState = a.state
        const b = nextRandom(rngState); rngState = b.state
        bubbles.push({ x: a.value * VIEW_W, y: 30 + b.value * 150, r: b.value < 0.5 ? 1 : 2, phase: a.value * 6.28 })
      }
      return {
        status: 'ready',
        score: 0,
        tokens: 0,
        distance: 0,
        gap: START_GAP,
        speed: START_SPEED,
        time: 0,
        player,
        obstacles: [],
        tokensList,
        bubbles,
        particles: [],
        shake: 0,
        rngState,
        nextId,
        spawnTimer: 1.2,
        tokenTimer: 0, // 旧档字段保留；不再有独立于障碍组的随机飘币
      }
    }

    /** 玩家物理：跳跃 / 滑铲 / 重力；输入是边沿触发。 */
    function stepPlayer(player, dt, input, speed) {
      const next = { ...player }
      const events = []
      const grounded = next.y >= 0 && next.vy >= 0
      const keys = input || {}
      if (keys.jump && grounded) {
        next.vy = JUMP_V
        next.y = -0.01
        next.sliding = false
        next.slideTimer = 0
        events.push('jump')
      }
      if (keys.slide) {
        if (grounded) {
          next.sliding = true
          next.slideTimer = SLIDE_TIME
          events.push('slide')
        } else if (next.vy < 380) {
          next.vy = 380
        }
      }
      if (next.slideTimer > 0) {
        next.slideTimer -= dt
        if (next.slideTimer <= 0) {
          next.sliding = false
          next.slideTimer = 0
        }
      }
      next.vy += GRAVITY * dt
      next.y += next.vy * dt
      if (next.y >= 0) {
        next.y = 0
        next.vy = 0
      }
      next.anim += dt * ((Number(speed) || START_SPEED) / START_SPEED)
      return { player: next, events }
    }

    /** 推进一帧；返回 { game, events }。events 只给音效 / UI 用。 */
    function stepGame(game, dt, input) {
      if (!game || game.status !== 'running') return { game, events: [] }
      const step = Math.max(0, Math.min(0.05, Number(dt) || 0))
      const events = []
      const oldDistance = game.distance
      const speed = speedFor(game.distance)
      let rngState = game.rngState
      const rand = () => { const result = nextRandom(rngState); rngState = result.state; return result.value }

      const next = {
        ...game,
        player: { ...game.player },
        obstacles: game.obstacles.map((obstacle) => ({ ...obstacle })),
        tokensList: game.tokensList.map((token) => ({ ...token })),
        bubbles: game.bubbles.map((bubble) => ({ ...bubble })),
        particles: game.particles.map((particle) => ({ ...particle })),
        speed,
        time: game.time + step,
      }
      next.distance = game.distance + speed * step / 10

      // 关卡图案：1~3 个障碍成组出现，间距按动作时间留够
      next.spawnTimer = game.spawnTimer - step
      if (next.spawnTimer <= 0) {
        const pattern = createObstaclePattern(rngState, next.distance, next.speed)
        rngState = pattern.rngState
        for (const template of pattern.obstacles) {
          const obstacle = { id: next.nextId, type: template.type, x: template.x, sector: pattern.sector }
          next.nextId += 1
          next.obstacles.push(obstacle)
          const formation = createObstacleTokens(rngState, next.nextId, obstacle, next.speed)
          rngState = formation.rngState
          next.nextId = formation.nextId
          for (const token of formation.tokens) next.tokensList.push(token)
        }
        // 在最后一个障碍后规划一个真正安全的糖豆图案，随后才生成下一组障碍。
        const lastObstacle = next.obstacles[next.obstacles.length - 1]
        if (lastObstacle) {
          const gift = createBonusTokens(rngState, next.nextId, pattern,
            { ...lastObstacle, distance: next.distance }, next.speed)
          rngState = gift.rngState
          next.nextId = gift.nextId
          for (const token of gift.tokens) next.tokensList.push(token)
        }
        next.tokensList = tokensClearOfObstacles(next.tokensList, next.obstacles)
        next.spawnTimer = pattern.endOffset / next.speed + pattern.restTime
      }
      // Token 不再按独立计时器随机刷出，避免破坏操作路线。
      next.tokenTimer = 0

      const dx = speed * step
      for (const obstacle of next.obstacles) obstacle.x -= dx
      for (const token of next.tokensList) {
        token.x -= dx
        token.phase += step * 2.2
      }
      next.obstacles = next.obstacles.filter((obstacle) => obstacle.x > -70)
      next.tokensList = tokensClearOfObstacles(next.tokensList.filter((token) => token.x > -30), next.obstacles)
      for (const bubble of next.bubbles) {
        bubble.y -= 10 * step
        if (bubble.y < 18) bubble.y = 190
      }

      const moved = stepPlayer(game.player, step, input, next.speed)
      next.player = moved.player
      events.push(...moved.events)
      if (moved.events.includes('jump')) {
        next.particles.push({ x: PLAYER_X - 8, y: GROUND_Y - 2, vx: -30, vy: -20, life: 0.3, kind: 'dust' })
      }
      if (moved.events.includes('slide')) {
        next.particles.push({ x: PLAYER_X - 12, y: GROUND_Y - 2, vx: -50, vy: -10, life: 0.35, kind: 'dust' })
      }

      // 达里奥慢慢逼近；token 拉距离
      next.gap = game.gap - GAP_DRAIN * step

      const height = next.player.sliding ? SLIDE_H : PLAYER_H
      const feet = GROUND_Y + next.player.y
      const top = feet - height
      const playerLeft = PLAYER_X - PLAYER_W / 2
      const playerRight = PLAYER_X + PLAYER_W / 2

      const survivors = []
      for (const obstacle of next.obstacles) {
        const width = obstacle.type === 'low' ? LOW_W : HIGH_W
        if (playerRight < obstacle.x || playerLeft > obstacle.x + width) {
          survivors.push(obstacle)
          continue
        }
        let collides = false
        if (obstacle.type === 'low') collides = feet > GROUND_Y - LOW_H
        else collides = top < HIGH_BOTTOM && feet > HIGH_TOP
        if (!collides || next.player.invuln > 0) {
          survivors.push(obstacle)
          continue
        }
        next.gap -= HIT_GAP
        next.player.invuln = HIT_INVULN
        next.shake = 3
        events.push('hit')
        // 撞上的障碍直接碎掉，不会连续掉血
      }
      next.obstacles = survivors

      const keptTokens = []
      const bodyHalfW = PLAYER_W / 2
      const bodyHalfH = height / 2
      const centerY = feet - height / 2
      for (const token of next.tokensList) {
        if (
          Math.abs(token.x - PLAYER_X) <= bodyHalfW + TOKEN_SIZE / 2 &&
          Math.abs(token.y - centerY) <= bodyHalfH + TOKEN_SIZE / 2
        ) {
          next.tokens += 1
          next.gap = Math.min(MAX_GAP, next.gap + TOKEN_GAP)
          events.push('token')
          next.particles.push({
            x: token.x, y: token.y,
            vx: (rand() - 0.5) * 60, vy: (rand() - 0.5) * 60,
            life: 0.4, kind: 'token',
          })
        } else {
          keptTokens.push(token)
        }
      }
      next.tokensList = keptTokens

      next.gap = Math.max(0, next.gap)
      next.player.invuln = Math.max(0, next.player.invuln - step)
      next.shake = Math.max(0, next.shake - step * 10)
      next.particles = next.particles.filter((particle) => {
        particle.x += particle.vx * step
        particle.y += particle.vy * step
        particle.life -= step
        return particle.life > 0
      })
      next.score = next.tokens * TOKEN_SCORE + Math.floor(next.distance)

      if (Math.floor(next.distance / MILESTONE) > Math.floor(oldDistance / MILESTONE)) {
        events.push('milestone')
      }
      if (sectorOf(next.distance) > sectorOf(oldDistance)) {
        events.push('sector')
      }
      if (next.gap <= 0) {
        next.status = 'over'
        events.push('caught')
      }
      next.rngState = rngState
      return { game: next, events }
    }

    function snapshotGame(game) {
      if (!game || typeof game !== 'object') return null
      const status = game.status === 'running' ? 'paused' : game.status
      if (status !== 'ready' && status !== 'paused' && status !== 'over') return null
      const player = game.player || {}
      if (!isFiniteNumber(player.y)) return null
      const obstacles = Array.isArray(game.obstacles)
        ? game.obstacles.filter((item) => item && isFiniteNumber(item.x))
        : []
      const tokensList = Array.isArray(game.tokensList)
        ? game.tokensList.filter((item) => item && isFiniteNumber(item.x) && isFiniteNumber(item.y))
        : []
      const bubbles = Array.isArray(game.bubbles)
        ? game.bubbles.filter((item) => item && isFiniteNumber(item.x) && isFiniteNumber(item.y))
        : []
      return {
        status,
        score: Math.max(0, Math.floor(Number(game.score) || 0)),
        tokens: Math.max(0, Math.floor(Number(game.tokens) || 0)),
        distance: Math.max(0, Number(game.distance) || 0),
        gap: clamp(Number(game.gap) || 0, 0, MAX_GAP),
        speed: clamp(Number(game.speed) || START_SPEED, START_SPEED, MAX_SPEED),
        time: Math.max(0, Number(game.time) || 0),
        rngState: Number.isFinite(game.rngState) ? (game.rngState >>> 0) : randomSeed(),
        nextId: Math.max(1, Math.floor(Number(game.nextId) || 1)),
        spawnTimer: clamp(Number(game.spawnTimer) || 0, 0, 8),
        tokenTimer: clamp(Number(game.tokenTimer) || 0, 0, 2),
        player: {
          y: clamp(Number(player.y) || 0, -140, 0),
          vy: clamp(Number(player.vy) || 0, -800, 800),
          sliding: Boolean(player.sliding),
          slideTimer: clamp(Number(player.slideTimer) || 0, 0, SLIDE_TIME),
          invuln: Math.max(0, Number(player.invuln) || 0),
          anim: Number(player.anim) || 0,
        },
        obstacles: obstacles.slice(0, 40).map((item) => ({
          id: Math.max(1, Math.floor(Number(item.id) || 1)),
          type: item.type === 'high' ? 'high' : 'low',
          sector: [0, 1, 2].includes(item.sector) ? item.sector : (sectorOf(game.distance) - 1) % 3,
          x: clamp(Number(item.x) || 0, -80, TOKEN_MAX_X),
        })),
        tokensList: tokensList.slice(0, 80).map((item) => ({
          id: Math.max(1, Math.floor(Number(item.id) || 1)),
          x: clamp(Number(item.x) || 0, -60, TOKEN_MAX_X),
          kind: item.kind === 'guide' ? 'guide' : 'bonus',
          formation: typeof item.formation === 'string' ? item.formation : 'legacy',
          y: clamp(Number(item.y) || 0, 0, VIEW_H),
          phase: Number(item.phase) || 0,
        })),
        bubbles: bubbles.slice(0, 40).map((item) => ({
          x: clamp(Number(item.x) || 0, 0, VIEW_W),
          y: clamp(Number(item.y) || 0, 0, VIEW_H),
          r: item.r === 2 ? 2 : 1,
          phase: Number(item.phase) || 0,
        })),
      }
    }

    function restoreGame(raw) {
      if (!raw || typeof raw !== 'object') return null
      if (!raw.player || !isFiniteNumber(raw.player.y)) return null
      const status = raw.status === 'over' ? 'over' : raw.status === 'ready' ? 'ready' : 'paused'
      const player = {
        y: clamp(Number(raw.player.y) || 0, -140, 0),
        vy: clamp(Number(raw.player.vy) || 0, -800, 800),
        sliding: Boolean(raw.player.sliding),
        slideTimer: clamp(Number(raw.player.slideTimer) || 0, 0, SLIDE_TIME),
        invuln: Math.max(0, Number(raw.player.invuln) || 0),
        anim: Number(raw.player.anim) || 0,
      }
      if (raw.obstacles !== undefined && !Array.isArray(raw.obstacles)) return null
      if (raw.tokensList !== undefined && !Array.isArray(raw.tokensList)) return null
      if (raw.bubbles !== undefined && !Array.isArray(raw.bubbles)) return null
      const obstacles = []
      for (const item of Array.isArray(raw.obstacles) ? raw.obstacles : []) {
        if (!item || !isFiniteNumber(item.x)) continue
        obstacles.push({
          id: Math.max(1, Math.floor(Number(item.id) || obstacles.length + 1)),
          type: item.type === 'high' ? 'high' : 'low',
          sector: [0, 1, 2].includes(item.sector) ? item.sector : (sectorOf(raw.distance) - 1) % 3,
          x: clamp(Number(item.x) || 0, -80, TOKEN_MAX_X),
        })
      }
      const tokensList = []
      for (const item of Array.isArray(raw.tokensList) ? raw.tokensList : []) {
        if (!item || !isFiniteNumber(item.x) || !isFiniteNumber(item.y)) continue
        tokensList.push({
          id: Math.max(1, Math.floor(Number(item.id) || tokensList.length + 1)),
          x: clamp(Number(item.x) || 0, -60, TOKEN_MAX_X),
          kind: item.kind === 'guide' ? 'guide' : 'bonus',
          formation: typeof item.formation === 'string' ? item.formation : 'legacy',
          y: clamp(Number(item.y) || 0, 0, VIEW_H),
          phase: Number(item.phase) || 0,
        })
      }
      const bubbles = []
      for (const item of Array.isArray(raw.bubbles) ? raw.bubbles : []) {
        if (!item || !isFiniteNumber(item.x) || !isFiniteNumber(item.y)) continue
        bubbles.push({
          x: clamp(Number(item.x) || 0, 0, VIEW_W),
          y: clamp(Number(item.y) || 0, 0, VIEW_H),
          r: item.r === 2 ? 2 : 1,
          phase: Number(item.phase) || 0,
        })
      }
      const tokens = Math.max(0, Math.floor(Number(raw.tokens) || 0))
      const distance = Math.max(0, Number(raw.distance) || 0)
      return {
        status,
        score: Number.isFinite(raw.score)
          ? Math.max(0, Math.floor(raw.score))
          : tokens * TOKEN_SCORE + Math.floor(distance),
        tokens,
        distance,
        gap: clamp(Number(raw.gap) || 0, 0, MAX_GAP),
        speed: clamp(Number(raw.speed) || START_SPEED, START_SPEED, MAX_SPEED),
        time: Math.max(0, Number(raw.time) || 0),
        player,
        obstacles,
        tokensList,
        bubbles,
        particles: [],
        shake: 0,
        rngState: Number.isFinite(raw.rngState) ? (raw.rngState >>> 0) : randomSeed(),
        nextId: Math.max(1, Math.floor(Number(raw.nextId) || 1)),
        spawnTimer: clamp(isFiniteNumber(raw.spawnTimer) ? raw.spawnTimer : 0.8, 0, 8),
        tokenTimer: clamp(isFiniteNumber(raw.tokenTimer) ? raw.tokenTimer : 0.5, 0, 2),
      }
    }
    // #endregion game-core

    // ── 本地存档 ────────────────────────────────────────────────────────────
    function readLS(key) {
      try { return window.localStorage.getItem(key) } catch (error) { return null }
    }
    function writeLS(key, value) {
      try { window.localStorage.setItem(key, value) } catch (error) { /* 无痕模式忽略 */ }
    }
    function readJSON(key) {
      const raw = readLS(key)
      if (!raw) return null
      try { return JSON.parse(raw) } catch (error) { return null }
    }
    function writeJSON(key, value) { writeLS(key, JSON.stringify(value)) }
    function loadBest() {
      const value = Number(readLS(LS_BEST))
      return isFiniteNumber(value) && value > 0 ? Math.floor(value) : 0
    }
    function saveBest(score) { writeLS(LS_BEST, String(Math.max(0, Math.floor(score) || 0))) }
    function loadSoundOn() { return readLS(LS_SOUND) !== 'off' }
    function saveSoundOn(on) { writeLS(LS_SOUND, on ? 'on' : 'off') }
    function persistGame(game) {
      const snapshot = snapshotGame(game)
      if (!snapshot || snapshot.status === 'ready') return
      writeJSON(LS_GAME, snapshot)
    }
    function loadGameState() {
      const restored = restoreGame(readJSON(LS_GAME))
      return { game: restored || createGame({ seed: randomSeed() }), best: loadBest(), soundOn: loadSoundOn() }
    }

    // ── 音效：WebAudio 合成，不引音频文件 ───────────────────────────────────
    let audioCtx = null
    function withAudio(callback) {
      if (typeof window === 'undefined') return
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return
        if (!audioCtx) audioCtx = new Ctor()
        if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') audioCtx.resume()
        callback(audioCtx)
      } catch (error) { /* 没有音频能力就当静音 */ }
    }
    function tone(ctx, freq, durationMs, type, peak, delayMs) {
      try {
        const start = ctx.currentTime + (delayMs || 0) / 1000
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        const end = start + durationMs / 1000
        osc.type = type || 'square'
        osc.frequency.setValueAtTime(freq, start)
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(peak || 0.04, start + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, end)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(start)
        osc.stop(end + 0.02)
      } catch (error) { /* 单次发声失败不影响游戏 */ }
    }
    function playSfx(kind) {
      withAudio((ctx) => {
        if (kind === 'jump') {
          tone(ctx, 420, 70, 'square', 0.03, 0)
          tone(ctx, 660, 60, 'square', 0.024, 0.05)
        } else if (kind === 'slide') {
          tone(ctx, 180, 130, 'sawtooth', 0.03, 0)
        } else if (kind === 'token') {
          tone(ctx, 880, 45, 'square', 0.03, 0)
          tone(ctx, 1320, 45, 'square', 0.022, 0.04)
        } else if (kind === 'hit') {
          tone(ctx, 150, 140, 'sawtooth', 0.045, 0)
          tone(ctx, 110, 160, 'square', 0.035, 0.1)
        } else if (kind === 'milestone') {
          ;[660, 880, 1046].forEach((freq, index) => tone(ctx, freq, 70, 'square', 0.026, index * 60))
        } else if (kind === 'caught') {
          ;[392, 311, 262, 196].forEach((freq, index) => tone(ctx, freq, 150, 'square', 0.04, index * 110))
        } else if (kind === 'start') {
          tone(ctx, 523, 60, 'square', 0.035, 0)
          tone(ctx, 784, 70, 'square', 0.03, 0.06)
        } else if (kind === 'pause') {
          tone(ctx, 660, 45, 'square', 0.03, 0)
          tone(ctx, 440, 55, 'square', 0.03, 0.05)
        }
      })
    }

    // ── 图标 ────────────────────────────────────────────────────────────────
    function IconClawd(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 18
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24',
          'aria-hidden': true, focusable: 'false',
          style: { display: 'block', opacity: active ? 1 : 0.9 },
        },
        h('g', { fill: 'currentColor' },
          h('path', { fillRule: 'evenodd', d: 'M7 7h10v11H7z M9 9h2v2H9z M13 9h2v2h-2z' }),
          h('rect', { x: 3, y: 11, width: 4, height: 2 }),
          h('rect', { x: 17, y: 11, width: 4, height: 2 }),
          h('rect', { x: 7, y: 18, width: 1, height: 3 }),
          h('rect', { x: 10, y: 18, width: 1, height: 3 }),
          h('rect', { x: 13, y: 18, width: 1, height: 3 }),
          h('rect', { x: 16, y: 18, width: 1, height: 3 }),
        ),
      )
    }

    function LogoClawd(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 26
      return h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 32 32',
          'aria-hidden': true, focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { width: 32, height: 32, rx: 7, fill: '#08111b' }),
        h('g', { fill: '#d97757' },
          h('rect', { x: 4, y: 16, width: 6, height: 3 }),
          h('rect', { x: 22, y: 16, width: 6, height: 3 }),
          h('rect', { x: 9, y: 11, width: 14, height: 14 }),
          h('rect', { x: 9, y: 25, width: 2, height: 4 }),
          h('rect', { x: 13, y: 25, width: 2, height: 4 }),
          h('rect', { x: 17, y: 25, width: 2, height: 4 }),
          h('rect', { x: 21, y: 25, width: 2, height: 4 }),
        ),
        h('g', { fill: '#1a1a1a' },
          h('rect', { x: 12, y: 15, width: 3, height: 3 }),
          h('rect', { x: 18, y: 15, width: 3, height: 3 }),
        ),
        h('rect', { x: 9, y: 22, width: 14, height: 2, fill: '#b45f41' }),
      )
    }

    // ── 画面：400×225 现代数据中心 ──────────────────────────────────────────
    const SKY = ['#173249', '#1c3b55', '#224763', '#2a5472']
    const CEIL = '#132638'
    const PANEL = '#2a4d68'
    const PANEL_LIGHT = '#3f6b88'
    const METAL = '#5a8098'
    const METAL_HI = '#8fb4c8'
    const METAL_DARK = '#1d3548'
    const FLOOR = '#1c3342'
    const FLOOR_TILE = '#244152'
    const FLOOR_HI = '#4a7f97'
    const CYAN = '#67e8d6'
    const CYAN_DIM = '#2f9f92'
    const WHITE_LIGHT = '#e8f4ff'
    const LED_GREEN = '#5bd68a'
    const LED_AMBER = '#f2c14e'
    const LED_RED = '#f25f5c'
    const LED_BLUE = '#7fd0e8'
    const TOKEN = { main: '#ffc44d', hi: '#fff4b7', dark: '#b86b25', edge: '#321f16', bonus: '#ffb69a' }
    const CRATE = { main: '#6b8ba1', hi: '#a8c6d8', dark: '#2a3f4f', stripe: '#ffcc4d' }
    const LASER = { beam: '#ff4d4d', glow: 'rgba(255,77,77,.28)', post: '#5a8098', postHi: '#a8c6d8' }
    const CLAWD = { body: '#e8875a', dark: '#b85f3a', belly: '#f6d3b3', eye: '#141414' }
    const DARIO = { suit: '#2b2f3a', suitHi: '#3a4050', shirt: '#d9d4c7', tie: '#b33a3a', skin: '#d9a77c', hair: '#2a2220', glasses: '#111820' }
    // 用户提供的 Running-Dario.gif，已拆成 12 帧精灵表内嵌（透明底）。
    const DARIO_SHEET = 'data:image/png;base64,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'
    const DARIO_FRAME_W = 51
    const DARIO_FRAME_H = 56
    const DARIO_FRAMES = 12
    // 用户提供的 Clawd-running.gif / Clawd-sliding.gif，各 12 帧、透明底，拆成横向精灵表内嵌。
    const CLAWD_RUN_SHEET = 'data:image/png;base64,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'
    const CLAWD_SLIDE_SHEET = 'data:image/png;base64,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'
    const CLAWD_RUN_FRAME_W = 46
    const CLAWD_RUN_FRAME_H = 36
    const CLAWD_SLIDE_FRAME_W = 62
    const CLAWD_SLIDE_FRAME_H = 28
    const CLAWD_FRAMES = 12
    const CLAWD_SLIDE_FRAMES = 4
    const DUST = '#8a7050'

    function pixelCircle(ctx, cx, cy, radius, color) {
      ctx.fillStyle = color
      for (let y = -radius; y <= radius; y += 1) {
        const half = Math.floor(Math.sqrt(radius * radius - y * y))
        ctx.fillRect(cx - half, cy + y, half * 2 + 1, 1)
      }
    }

    function drawLightStrip(ctx, x, y, width, now, seed) {
      const flicker = ((Math.floor(now / 700) + seed) % 11 === 0) ? 0.35 : 1
      ctx.globalAlpha = 0.08 * flicker
      ctx.fillStyle = WHITE_LIGHT
      ctx.fillRect(x - 7, y - 5, width + 14, 13)
      ctx.globalAlpha = flicker
      ctx.fillStyle = WHITE_LIGHT
      ctx.fillRect(x, y, width, 3)
      ctx.fillStyle = CYAN
      ctx.fillRect(x, y + 3, width, 1)
      ctx.globalAlpha = 1
    }

    function drawRack(ctx, x, y, width, height, seed, now) {
      ctx.fillStyle = METAL
      ctx.fillRect(x - 2, y - 2, width + 4, height + 4)
      ctx.fillStyle = PANEL
      ctx.fillRect(x, y, width, height)
      ctx.fillStyle = PANEL_LIGHT
      ctx.fillRect(x, y, width, 3)
      ctx.fillStyle = '#08121b'
      ctx.fillRect(x + 3, y + 5, width - 6, height - 9)
      const rows = Math.floor((height - 12) / 8)
      for (let row = 0; row < rows; row += 1) {
        const ry = y + 7 + row * 8
        ctx.fillStyle = '#152635'
        ctx.fillRect(x + 4, ry, width - 8, 1)
        const blink = ((Math.floor(now / 260) + row * 3 + seed * 7) % 7) !== 0
        if (blink) {
          ctx.fillStyle = row % 3 === 0 ? LED_GREEN : row % 3 === 1 ? LED_BLUE : LED_AMBER
          ctx.fillRect(x + 5, ry + 2, 2, 2)
          ctx.fillRect(x + width - 8, ry + 2, 2, 2)
        }
        ctx.fillStyle = '#0d1a25'
        ctx.fillRect(x + 10, ry + 3, width - 18, 1)
      }
      ctx.fillStyle = METAL
      ctx.fillRect(x + width - 5, y + 7, 2, 8)
      ctx.fillStyle = CYAN_DIM
      ctx.fillRect(x + 3, y + height - 6, width - 6, 1)
      ctx.fillStyle = 'rgba(120,220,230,.35)'
      ctx.fillRect(x, y, width, 1)
      ctx.fillRect(x, y, 1, height)
    }

    function drawFan(ctx, cx, cy, radius, now, seed) {
      pixelCircle(ctx, cx, cy, radius + 3, METAL_DARK)
      pixelCircle(ctx, cx, cy, radius + 1, '#0a141d')
      const angle = now / (260 + seed * 40)
      ctx.fillStyle = METAL_HI
      for (let blade = 0; blade < 3; blade += 1) {
        const a = angle + (blade * Math.PI * 2) / 3
        for (let t = 2; t < radius; t += 2) {
          ctx.fillRect(Math.round(cx + Math.cos(a) * t), Math.round(cy + Math.sin(a) * t), 1, 2)
        }
      }
      ctx.fillStyle = CYAN_DIM
      ctx.fillRect(cx - 1, cy - 1, 2, 2)
    }

    function drawExitSign(ctx, x, y, now) {
      const originalAlpha = ctx.globalAlpha
      const glow = 0.10 + Math.abs(Math.sin(now / 900 + x)) * 0.08
      ctx.globalAlpha = originalAlpha * glow
      ctx.fillStyle = LED_GREEN
      ctx.fillRect(x - 3, y - 3, 32, 16)
      ctx.globalAlpha = originalAlpha
      ctx.fillStyle = '#0c3b2c'
      ctx.fillRect(x, y, 26, 10)
      ctx.fillStyle = LED_GREEN
      ctx.fillRect(x + 6, y + 4, 9, 2)
      ctx.fillRect(x + 13, y + 2, 2, 2)
      ctx.fillRect(x + 13, y + 6, 2, 2)
      ctx.fillRect(x + 2, y + 2, 2, 6)
    }

    function drawGlassRoom(ctx, x, y, width, height, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 3, y - 3, width + 6, height + 6)
      ctx.fillStyle = PANEL
      ctx.fillRect(x, y, width, height)
      ctx.fillStyle = '#0a1722'
      ctx.fillRect(x + 3, y + 3, width - 6, height - 6)
      const count = 2 + (seed % 2)
      for (let i = 0; i < count; i += 1) {
        const rackWidth = 13 + ((seed + i) % 3) * 3
        const rx = x + 8 + i * (rackWidth + 8)
        if (rx + rackWidth > x + width - 5) break
        drawRack(ctx, rx, y + 9, rackWidth, height - 18, seed + i + 1, now)
      }
      ctx.fillStyle = 'rgba(120,220,230,.07)'
      ctx.fillRect(x + 3, y + 3, width - 6, height - 6)
      ctx.fillStyle = 'rgba(170,235,245,.16)'
      ctx.fillRect(x + 4, y + 4, 2, height - 8)
      ctx.fillStyle = METAL
      ctx.fillRect(x, y, width, 2)
      ctx.fillRect(x, y, 2, height)
      ctx.fillRect(x + width - 2, y, 2, height)
      ctx.fillStyle = CYAN_DIM
      ctx.fillRect(x + width - 12, y + Math.floor(height / 2), 2, 6)
      ctx.fillStyle = LED_GREEN
      ctx.fillRect(x + 6, y + 5, 8, 2)
    }

    function drawBulkheadDoor(ctx, x, y, width, height, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 4, y - 4, width + 8, height + 4)
      ctx.fillStyle = PANEL
      ctx.fillRect(x, y, width, height)
      ctx.fillStyle = '#0a1620'
      ctx.fillRect(x + 4, y + 4, width - 8, height - 8)
      ctx.fillStyle = METAL
      ctx.fillRect(x + 4, y + 4, width - 8, 2)
      ctx.fillRect(x + 4, y + 4, 2, height - 8)
      ctx.fillRect(x + width - 6, y + 4, 2, height - 8)
      ctx.fillStyle = '#111f2b'
      ctx.fillRect(Math.round(x + width / 2) - 1, y + 6, 2, height - 12)
      ctx.fillStyle = CRATE.stripe
      ctx.fillRect(x + 6, y + height - 12, width - 12, 3)
      ctx.fillStyle = '#0b1118'
      for (let i = 0; i < 3; i += 1) ctx.fillRect(x + 10 + i * 10, y + height - 12, 3, 3)
      ctx.fillStyle = '#0d1c26'
      ctx.fillRect(x + width - 16, y + 10, 8, 12)
      ctx.fillStyle = (Math.floor(now / 900) + seed) % 2 === 0 ? LED_GREEN : LED_RED
      ctx.fillRect(x + width - 13, y + 13, 2, 2)
      ctx.fillStyle = PANEL_LIGHT
      ctx.fillRect(x + 8, y - 7, width - 16, 5)
      ctx.fillStyle = CYAN
      ctx.fillRect(x + 12, y - 6, 10, 1)
      ctx.fillRect(x + 26, y - 6, 4, 1)
    }

    function drawServerBank(ctx, x, y, seed, now) {
      const count = 2 + (seed % 2)
      let cursor = x
      for (let i = 0; i < count; i += 1) {
        const width = 26 + ((seed + i) % 3) * 8
        const top = y - ((seed + i) % 3) * 7
        drawRack(ctx, cursor, top, width, GROUND_Y - top, seed + i + 1, now)
        cursor += width + 7
      }
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 2, y - 12, cursor - x + 2, 3)
      ctx.fillStyle = METAL
      ctx.fillRect(x - 2, y - 12, cursor - x + 2, 1)
      for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 12 + i * 22, y - 14, 2, 4)
    }

    function drawPipeJunction(ctx, x, y, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x, y, 16, GROUND_Y - y)
      ctx.fillStyle = METAL
      ctx.fillRect(x + 1, y, 3, GROUND_Y - y)
      ctx.fillRect(x + 12, y, 2, GROUND_Y - y)
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 18, y + 26, 52, 14)
      ctx.fillStyle = METAL
      ctx.fillRect(x - 18, y + 26, 52, 2)
      ctx.fillRect(x - 18, y + 38, 52, 2)
      pixelCircle(ctx, x + 8, y + 33, 7, METAL_DARK)
      pixelCircle(ctx, x + 8, y + 33, 5, '#0e1c27')
      const angle = now / 900 + seed
      ctx.fillStyle = METAL_HI
      for (let i = 0; i < 4; i += 1) {
        const a = angle + (i * Math.PI) / 2
        ctx.fillRect(Math.round(x + 8 + Math.cos(a) * 4), Math.round(y + 33 + Math.sin(a) * 4), 1, 3)
      }
      ctx.fillStyle = 'rgba(127,208,232,.22)'
      ctx.fillRect(x + 5, y + 42, 6, 1)
      ctx.fillStyle = METAL_HI
      ctx.fillRect(x + 4, y - 2, 2, 8)
    }

    function drawFanWall(ctx, x, y, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 4, y - 4, 78, 64)
      ctx.fillStyle = '#0a1620'
      ctx.fillRect(x, y, 70, 56)
      drawFan(ctx, x + 18, y + 28, 13, now, seed)
      drawFan(ctx, x + 50, y + 28, 13, now, seed + 1)
      ctx.fillStyle = METAL
      ctx.fillRect(x, y, 70, 2)
      ctx.fillRect(x, y, 2, 56)
      ctx.fillRect(x + 68, y, 2, 56)
      ctx.fillStyle = CYAN_DIM
      ctx.fillRect(x + 6, y + 50, 58, 1)
    }

    function drawTransformer(ctx, x, y, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 3, y - 3, 46, GROUND_Y - y + 3)
      ctx.fillStyle = PANEL
      ctx.fillRect(x, y, 40, GROUND_Y - y)
      ctx.fillStyle = '#0c1823'
      ctx.fillRect(x + 4, y + 5, 32, 16)
      for (let i = 0; i < 4; i += 1) {
        ctx.fillStyle = i % 2 === 0 ? LED_AMBER : '#3d2b1f'
        ctx.fillRect(x + 7 + i * 7, y + 9 + (i % 2) * 4, 2, 2)
      }
      ctx.fillStyle = METAL
      ctx.fillRect(x + 3, y + 25, 34, 2)
      for (let i = 0; i < 5; i += 1) {
        ctx.fillStyle = i % 2 === 0 ? '#6b4a2b' : '#3a2a1c'
        ctx.fillRect(x + 6, y + 32 + i * 8, 28, 4)
      }
      ctx.fillStyle = CRATE.stripe
      ctx.fillRect(x + 3, y + 74, 34, 4)
      ctx.fillStyle = '#101820'
      for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 6 + i * 8, y + 74, 3, 4)
      const blink = Math.floor(now / 280 + seed) % 2 === 0
      ctx.fillStyle = blink ? LED_RED : '#532024'
      ctx.fillRect(x + 30, y + 3, 4, 3)
      ctx.fillStyle = 'rgba(242,95,92,.16)'
      ctx.fillRect(x + 26, y, 12, 8)
    }

    function drawCoreColumn(ctx, x, y, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 4, y, 56, GROUND_Y - y)
      ctx.fillStyle = '#0a1622'
      ctx.fillRect(x, y + 4, 48, GROUND_Y - y - 8)
      ctx.fillStyle = CYAN_DIM
      ctx.fillRect(x + 20, y + 8, 8, GROUND_Y - y - 20)
      ctx.fillStyle = CYAN
      ctx.fillRect(x + 22, y + 12, 4, GROUND_Y - y - 28)
      for (let ring = 0; ring < 4; ring += 1) {
        const ry = y + 20 + ring * 26
        ctx.fillStyle = METAL
        ctx.fillRect(x - 2, ry, 52, 2)
        ctx.fillStyle = 'rgba(103,232,214,.2)'
        ctx.fillRect(x - 2, ry + 2, 52, 1)
      }
      const spark = (Math.floor(now / 120) + seed) % 9
      if (spark < 3) {
        ctx.fillStyle = WHITE_LIGHT
        ctx.fillRect(x + 30, y + 24 + spark * 18, 2, 4)
      }
      ctx.fillStyle = LED_RED
      ctx.fillRect(x + 4, y + 6, 2, 2)
    }

    function drawConduitWall(ctx, x, y, seed, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x, y, 44, GROUND_Y - y)
      for (let i = 0; i < 3; i += 1) {
        const px = x + 7 + i * 12
        ctx.globalAlpha = 0.62
        ctx.fillStyle = i === 1 ? LED_RED : CYAN_DIM
        ctx.fillRect(px, y, 4, GROUND_Y - y)
        ctx.globalAlpha = 1
        ctx.fillStyle = METAL_HI
        ctx.fillRect(px, y, 1, GROUND_Y - y)
        for (let j = 0; j < 3; j += 1) {
          ctx.fillStyle = METAL
          ctx.fillRect(px - 2, y + 18 + j * 28, 8, 3)
        }
      }
      ctx.fillStyle = PANEL_LIGHT
      ctx.fillRect(x - 4, y - 4, 52, 4)
    }

    function drawWallScreen(ctx, x, y, now, seed) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 2, y - 2, 44, 28)
      ctx.fillStyle = '#08131d'
      ctx.fillRect(x, y, 40, 24)
      ctx.fillStyle = 'rgba(103,232,214,.12)'
      ctx.fillRect(x + 3, y + 3, 34, 18)
      for (let i = 0; i < 4; i += 1) {
        ctx.fillStyle = i % 3 === 0 ? LED_AMBER : CYAN_DIM
        ctx.fillRect(x + 5 + i * 8, y + 6, 4, 2)
      }
      ctx.fillStyle = CYAN
      ctx.fillRect(x + 5, y + 13, 10 + ((seed + Math.floor(now / 800)) % 3) * 5, 1)
      ctx.fillStyle = PANEL_LIGHT
      ctx.fillRect(x + 34, y + 15, 2, 2)
    }

    function drawSecurityCamera(ctx, x, y, now) {
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x, y, 2, 12)
      ctx.fillStyle = PANEL
      ctx.fillRect(x - 5, y + 10, 12, 7)
      ctx.fillStyle = '#0a141d'
      ctx.fillRect(x - 8, y + 12, 4, 4)
      if (Math.floor(now / 700) % 3 === 0) {
        ctx.fillStyle = LED_RED
        ctx.fillRect(x + 4, y + 12, 2, 2)
      }
    }

    function drawSteamVent(ctx, x, now, strength) {
      ctx.fillStyle = '#0a1620'
      ctx.fillRect(x - 1, GROUND_Y - 2, 22, 3)
      ctx.fillStyle = METAL
      ctx.fillRect(x, GROUND_Y - 2, 20, 1)
      ctx.fillStyle = METAL_DARK
      for (let i = 0; i < 3; i += 1) ctx.fillRect(x + 3 + i * 6, GROUND_Y - 1, 2, 2)
      const base = now / 1100 + x * 0.013
      for (let i = 0; i < 3; i += 1) {
        const phase = ((base + i * 0.31) % 1 + 1) % 1
        const px = Math.round(x + 8 + Math.sin(base * 2 + i * 1.7) * 5)
        const py = Math.round(GROUND_Y - 4 - phase * 26)
        ctx.globalAlpha = (1 - phase) * 0.14 * strength
        ctx.fillStyle = '#cfeef5'
        ctx.fillRect(px, py, 3 + (i % 2), 3)
        ctx.fillRect(px + 2, py - 3, 2, 3)
        ctx.globalAlpha = 1
      }
    }

    // 程序化像素场景物件：均位于角色后方，不增加碰撞盒。
    // 原创 12 格像素道具 Atlas：保留 assets/scene-atlas.svg 源文件，并内嵌保证离线使用。
    const SCENE_ATLAS_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"192\" height=\"144\" viewBox=\"0 0 192 144\" shape-rendering=\"crispEdges\"><rect x=\"6\" y=\"6\" width=\"36\" height=\"33\" fill=\"#101c29\"/><rect x=\"9\" y=\"9\" width=\"30\" height=\"24\" fill=\"#2d4659\"/><rect x=\"12\" y=\"12\" width=\"24\" height=\"15\" fill=\"#172f40\"/><rect x=\"15\" y=\"15\" width=\"9\" height=\"3\" fill=\"#43959c\"/><rect x=\"27\" y=\"15\" width=\"6\" height=\"3\" fill=\"#6dac87\"/><rect x=\"15\" y=\"21\" width=\"15\" height=\"3\" fill=\"#69b2c9\"/><rect x=\"12\" y=\"30\" width=\"24\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"12\" y=\"36\" width=\"24\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"9\" y=\"39\" width=\"30\" height=\"3\" fill=\"#101c29\"/><rect x=\"18\" y=\"42\" width=\"12\" height=\"3\" fill=\"#2d4659\"/><rect x=\"3\" y=\"9\" width=\"3\" height=\"27\" fill=\"#88a2ac\"/><rect x=\"39\" y=\"9\" width=\"3\" height=\"27\" fill=\"#88a2ac\"/><rect x=\"60\" y=\"0\" width=\"24\" height=\"48\" fill=\"#101c29\"/><rect x=\"63\" y=\"3\" width=\"18\" height=\"42\" fill=\"#2d4659\"/><rect x=\"66\" y=\"6\" width=\"12\" height=\"6\" fill=\"#172f40\"/><rect x=\"66\" y=\"15\" width=\"12\" height=\"6\" fill=\"#172f40\"/><rect x=\"66\" y=\"24\" width=\"12\" height=\"6\" fill=\"#172f40\"/><rect x=\"66\" y=\"33\" width=\"12\" height=\"6\" fill=\"#172f40\"/><rect x=\"69\" y=\"9\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"75\" y=\"9\" width=\"3\" height=\"3\" fill=\"#69b2c9\"/><rect x=\"69\" y=\"18\" width=\"3\" height=\"3\" fill=\"#c49f52\"/><rect x=\"75\" y=\"18\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"69\" y=\"27\" width=\"3\" height=\"3\" fill=\"#69b2c9\"/><rect x=\"75\" y=\"27\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"69\" y=\"36\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"75\" y=\"36\" width=\"3\" height=\"3\" fill=\"#c49f52\"/><rect x=\"63\" y=\"3\" width=\"18\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"63\" y=\"42\" width=\"18\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"57\" y=\"6\" width=\"3\" height=\"36\" fill=\"#4c6a7b\"/><rect x=\"84\" y=\"6\" width=\"3\" height=\"36\" fill=\"#4c6a7b\"/><rect x=\"99\" y=\"12\" width=\"42\" height=\"27\" fill=\"#101c29\"/><rect x=\"102\" y=\"15\" width=\"36\" height=\"21\" fill=\"#4c6a7b\"/><rect x=\"105\" y=\"18\" width=\"30\" height=\"15\" fill=\"#2d4659\"/><rect x=\"105\" y=\"21\" width=\"30\" height=\"6\" fill=\"#172f40\"/><rect x=\"108\" y=\"21\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"114\" y=\"21\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"120\" y=\"21\" width=\"3\" height=\"3\" fill=\"#69b2c9\"/><rect x=\"126\" y=\"21\" width=\"3\" height=\"3\" fill=\"#c49f52\"/><rect x=\"132\" y=\"21\" width=\"3\" height=\"3\" fill=\"#6dac87\"/><rect x=\"105\" y=\"30\" width=\"30\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"102\" y=\"36\" width=\"36\" height=\"3\" fill=\"#101c29\"/><rect x=\"108\" y=\"39\" width=\"6\" height=\"6\" fill=\"#2d4659\"/><rect x=\"126\" y=\"39\" width=\"6\" height=\"6\" fill=\"#2d4659\"/><rect x=\"147\" y=\"15\" width=\"42\" height=\"24\" fill=\"#101c29\"/><rect x=\"150\" y=\"18\" width=\"36\" height=\"18\" fill=\"#4c6a7b\"/><rect x=\"156\" y=\"9\" width=\"21\" height=\"12\" fill=\"#2d4659\"/><rect x=\"159\" y=\"12\" width=\"15\" height=\"6\" fill=\"#172f40\"/><rect x=\"159\" y=\"15\" width=\"6\" height=\"3\" fill=\"#6dac87\"/><rect x=\"168\" y=\"15\" width=\"3\" height=\"3\" fill=\"#c49f52\"/><rect x=\"153\" y=\"21\" width=\"30\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"153\" y=\"30\" width=\"30\" height=\"3\" fill=\"#2d4659\"/><rect x=\"153\" y=\"36\" width=\"6\" height=\"6\" fill=\"#101c29\"/><rect x=\"177\" y=\"36\" width=\"6\" height=\"6\" fill=\"#101c29\"/><rect x=\"153\" y=\"42\" width=\"9\" height=\"6\" fill=\"#88a2ac\"/><rect x=\"174\" y=\"42\" width=\"9\" height=\"6\" fill=\"#88a2ac\"/><rect x=\"18\" y=\"48\" width=\"12\" height=\"48\" fill=\"#101c29\"/><rect x=\"21\" y=\"48\" width=\"6\" height=\"48\" fill=\"#4c6a7b\"/><rect x=\"3\" y=\"66\" width=\"42\" height=\"12\" fill=\"#101c29\"/><rect x=\"6\" y=\"69\" width=\"36\" height=\"6\" fill=\"#69b2c9\"/><rect x=\"9\" y=\"51\" width=\"30\" height=\"3\" fill=\"#2d4659\"/><rect x=\"12\" y=\"54\" width=\"24\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"21\" y=\"54\" width=\"6\" height=\"12\" fill=\"#4c6a7b\"/><rect x=\"9\" y=\"60\" width=\"30\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"9\" y=\"63\" width=\"6\" height=\"3\" fill=\"#43959c\"/><rect x=\"33\" y=\"63\" width=\"6\" height=\"3\" fill=\"#43959c\"/><rect x=\"15\" y=\"66\" width=\"18\" height=\"12\" fill=\"#2d4659\"/><rect x=\"18\" y=\"69\" width=\"12\" height=\"6\" fill=\"#172f40\"/><rect x=\"21\" y=\"69\" width=\"6\" height=\"6\" fill=\"#69b2c9\"/><rect x=\"15\" y=\"81\" width=\"18\" height=\"6\" fill=\"#2d4659\"/><rect x=\"18\" y=\"84\" width=\"12\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"54\" y=\"66\" width=\"36\" height=\"21\" fill=\"#101c29\"/><rect x=\"57\" y=\"69\" width=\"30\" height=\"15\" fill=\"#4c6a7b\"/><rect x=\"60\" y=\"72\" width=\"24\" height=\"9\" fill=\"#172f40\"/><rect x=\"63\" y=\"72\" width=\"6\" height=\"6\" fill=\"#69b2c9\"/><rect x=\"75\" y=\"72\" width=\"6\" height=\"6\" fill=\"#69b2c9\"/><rect x=\"51\" y=\"75\" width=\"6\" height=\"9\" fill=\"#2d4659\"/><rect x=\"87\" y=\"75\" width=\"6\" height=\"9\" fill=\"#2d4659\"/><rect x=\"54\" y=\"84\" width=\"36\" height=\"6\" fill=\"#2d4659\"/><rect x=\"60\" y=\"90\" width=\"6\" height=\"6\" fill=\"#88a2ac\"/><rect x=\"78\" y=\"90\" width=\"6\" height=\"6\" fill=\"#88a2ac\"/><rect x=\"63\" y=\"60\" width=\"18\" height=\"6\" fill=\"#2d4659\"/><rect x=\"69\" y=\"57\" width=\"6\" height=\"3\" fill=\"#69b2c9\"/><rect x=\"66\" y=\"54\" width=\"12\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"69\" y=\"78\" width=\"6\" height=\"3\" fill=\"#43959c\"/><rect x=\"99\" y=\"51\" width=\"42\" height=\"42\" fill=\"#101c29\"/><rect x=\"102\" y=\"54\" width=\"36\" height=\"36\" fill=\"#2d4659\"/><rect x=\"105\" y=\"57\" width=\"30\" height=\"30\" fill=\"#172f40\"/><rect x=\"117\" y=\"57\" width=\"6\" height=\"12\" fill=\"#88a2ac\"/><rect x=\"123\" y=\"69\" width=\"12\" height=\"6\" fill=\"#88a2ac\"/><rect x=\"117\" y=\"75\" width=\"6\" height=\"12\" fill=\"#88a2ac\"/><rect x=\"105\" y=\"69\" width=\"12\" height=\"6\" fill=\"#88a2ac\"/><rect x=\"114\" y=\"66\" width=\"12\" height=\"12\" fill=\"#4c6a7b\"/><rect x=\"117\" y=\"69\" width=\"6\" height=\"6\" fill=\"#43959c\"/><rect x=\"102\" y=\"54\" width=\"6\" height=\"6\" fill=\"#4c6a7b\"/><rect x=\"132\" y=\"54\" width=\"6\" height=\"6\" fill=\"#4c6a7b\"/><rect x=\"102\" y=\"84\" width=\"6\" height=\"6\" fill=\"#4c6a7b\"/><rect x=\"132\" y=\"84\" width=\"6\" height=\"6\" fill=\"#4c6a7b\"/><rect x=\"159\" y=\"48\" width=\"18\" height=\"6\" fill=\"#4c6a7b\"/><rect x=\"156\" y=\"54\" width=\"24\" height=\"6\" fill=\"#2d4659\"/><rect x=\"150\" y=\"60\" width=\"36\" height=\"30\" fill=\"#101c29\"/><rect x=\"153\" y=\"63\" width=\"30\" height=\"24\" fill=\"#4c6a7b\"/><rect x=\"156\" y=\"66\" width=\"24\" height=\"18\" fill=\"#172f40\"/><rect x=\"165\" y=\"69\" width=\"3\" height=\"12\" fill=\"#69b2c9\"/><rect x=\"165\" y=\"75\" width=\"12\" height=\"3\" fill=\"#b8665c\"/><rect x=\"156\" y=\"81\" width=\"24\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"159\" y=\"84\" width=\"18\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"165\" y=\"87\" width=\"6\" height=\"9\" fill=\"#2d4659\"/><rect x=\"150\" y=\"69\" width=\"3\" height=\"9\" fill=\"#88a2ac\"/><rect x=\"183\" y=\"69\" width=\"3\" height=\"9\" fill=\"#88a2ac\"/><rect x=\"159\" y=\"63\" width=\"18\" height=\"3\" fill=\"#43959c\"/><rect x=\"9\" y=\"99\" width=\"30\" height=\"42\" fill=\"#101c29\"/><rect x=\"12\" y=\"102\" width=\"24\" height=\"36\" fill=\"#2d4659\"/><rect x=\"15\" y=\"102\" width=\"18\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"15\" y=\"108\" width=\"18\" height=\"6\" fill=\"#76749a\"/><rect x=\"15\" y=\"117\" width=\"18\" height=\"6\" fill=\"#76749a\"/><rect x=\"15\" y=\"126\" width=\"18\" height=\"6\" fill=\"#76749a\"/><rect x=\"18\" y=\"105\" width=\"12\" height=\"30\" fill=\"#b8665c\"/><rect x=\"21\" y=\"105\" width=\"6\" height=\"30\" fill=\"#c49f52\"/><rect x=\"9\" y=\"105\" width=\"3\" height=\"30\" fill=\"#4c6a7b\"/><rect x=\"36\" y=\"105\" width=\"3\" height=\"30\" fill=\"#4c6a7b\"/><rect x=\"15\" y=\"138\" width=\"18\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"18\" y=\"141\" width=\"12\" height=\"3\" fill=\"#2d4659\"/><rect x=\"60\" y=\"96\" width=\"24\" height=\"48\" fill=\"#101c29\"/><rect x=\"63\" y=\"99\" width=\"18\" height=\"42\" fill=\"#2d4659\"/><rect x=\"66\" y=\"102\" width=\"12\" height=\"33\" fill=\"#172f40\"/><rect x=\"69\" y=\"105\" width=\"6\" height=\"27\" fill=\"#b8665c\"/><rect x=\"69\" y=\"108\" width=\"6\" height=\"6\" fill=\"#c49f52\"/><rect x=\"69\" y=\"120\" width=\"6\" height=\"6\" fill=\"#c49f52\"/><rect x=\"63\" y=\"108\" width=\"18\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"63\" y=\"120\" width=\"18\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"63\" y=\"132\" width=\"18\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"66\" y=\"135\" width=\"12\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"63\" y=\"138\" width=\"18\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"57\" y=\"102\" width=\"3\" height=\"39\" fill=\"#88a2ac\"/><rect x=\"84\" y=\"102\" width=\"3\" height=\"39\" fill=\"#88a2ac\"/><rect x=\"102\" y=\"105\" width=\"36\" height=\"36\" fill=\"#101c29\"/><rect x=\"105\" y=\"108\" width=\"30\" height=\"30\" fill=\"#2d4659\"/><rect x=\"108\" y=\"111\" width=\"24\" height=\"24\" fill=\"#172f40\"/><rect x=\"111\" y=\"114\" width=\"18\" height=\"6\" fill=\"#4c6a7b\"/><rect x=\"117\" y=\"117\" width=\"6\" height=\"12\" fill=\"#88a2ac\"/><rect x=\"120\" y=\"108\" width=\"6\" height=\"15\" fill=\"#b8665c\"/><rect x=\"111\" y=\"129\" width=\"18\" height=\"3\" fill=\"#c49f52\"/><rect x=\"108\" y=\"135\" width=\"24\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"102\" y=\"108\" width=\"3\" height=\"27\" fill=\"#88a2ac\"/><rect x=\"135\" y=\"108\" width=\"3\" height=\"27\" fill=\"#88a2ac\"/><rect x=\"114\" y=\"99\" width=\"12\" height=\"6\" fill=\"#2d4659\"/><rect x=\"117\" y=\"102\" width=\"6\" height=\"6\" fill=\"#b8665c\"/><rect x=\"147\" y=\"105\" width=\"42\" height=\"33\" fill=\"#101c29\"/><rect x=\"150\" y=\"108\" width=\"36\" height=\"27\" fill=\"#2d4659\"/><rect x=\"153\" y=\"111\" width=\"30\" height=\"21\" fill=\"#172f40\"/><rect x=\"156\" y=\"111\" width=\"24\" height=\"3\" fill=\"#b8665c\"/><rect x=\"165\" y=\"114\" width=\"6\" height=\"12\" fill=\"#c49f52\"/><rect x=\"162\" y=\"120\" width=\"12\" height=\"6\" fill=\"#b8665c\"/><rect x=\"156\" y=\"129\" width=\"24\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"150\" y=\"105\" width=\"36\" height=\"3\" fill=\"#4c6a7b\"/><rect x=\"156\" y=\"135\" width=\"24\" height=\"3\" fill=\"#88a2ac\"/><rect x=\"159\" y=\"99\" width=\"18\" height=\"6\" fill=\"#2d4659\"/><rect x=\"165\" y=\"102\" width=\"6\" height=\"3\" fill=\"#c49f52\"/></svg>"
    let sceneAtlas = null
    function getSceneAtlas() {
      if (typeof Image === 'undefined') return null
      if (!sceneAtlas) {
        sceneAtlas = new Image()
        sceneAtlas.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SCENE_ATLAS_SVG)
      }
      return sceneAtlas.complete && sceneAtlas.naturalWidth === 192 ? sceneAtlas : null
    }

    function drawMapExtraProps(ctx, worldX) {
      const atlas = getSceneAtlas()
      if (!atlas) return
      const unit = 245
      const first = Math.floor(worldX / unit) - 1
      for (let i = first; i < first + 5; i += 1) {
        const center = i * unit + 85
        if (center < 0) continue
        const x = Math.round(center - worldX)
        if (x < -55 || x > VIEW_W + 10) continue
        const biome = mapSegmentOf(center / 10).sector
        const sprite = biome * 4 + ((i % 4 + 4) % 4)
        const y = 67 + (i % 3 + 3) % 3 * 9
        ctx.drawImage(atlas, sprite % 4 * 48, Math.floor(sprite / 4) * 48, 48, 48, x, y, 40, 40)
      }
    }

    function drawPlayfieldContrast(ctx) {
      // 背景中能看见设备轮廓；但 118–180px 的玩家操作带永远降至低对比。
      ctx.fillStyle = 'rgba(4,13,22,.16)'
      ctx.fillRect(0, 78, VIEW_W, 40)
      ctx.fillStyle = 'rgba(4,13,22,.45)'
      ctx.fillRect(0, 118, VIEW_W, GROUND_Y - 118)
      // 实际跑道与背景的明确分隔线，不模糊真正的金币和障碍轮廓。
      ctx.fillStyle = '#426d77'
      ctx.fillRect(0, GROUND_Y, VIEW_W, 1)
    }

    function drawMapBeacon(ctx, x, y, now, seed) {
      const alpha = ctx.globalAlpha
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 5, y + 3, 10, 4)
      ctx.fillStyle = (Math.floor(now / 370) + seed) % 3 === 0 ? '#6d302d' : LED_RED
      ctx.fillRect(x - 2, y, 4, 3)
      ctx.globalAlpha = alpha * 0.18
      ctx.fillRect(x - 5, y - 3, 10, 8)
      ctx.globalAlpha = alpha
    }

    // 服务器区：安全扫描控制台 + 闪烁提示屏。
    function drawMapSecurityBay(ctx, x, now, seed) {
      const y = 64
      ctx.fillStyle = '#0c1c2a'
      ctx.fillRect(x - 4, y, 76, 111)
      ctx.fillStyle = METAL
      ctx.fillRect(x - 4, y, 4, 111)
      ctx.fillRect(x + 68, y, 4, 111)
      ctx.fillRect(x - 4, y, 76, 5)
      ctx.fillStyle = '#173547'
      ctx.fillRect(x + 4, y + 7, 60, 90)
      ctx.fillStyle = '#081b27'
      ctx.fillRect(x + 10, y + 10, 48, 32)
      ctx.fillStyle = CYAN_DIM
      for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 14 + i * 10, y + 17, 6, 2)
      ctx.fillStyle = WHITE_LIGHT
      ctx.fillRect(x + 14, y + 26, 22 + ((seed + Math.floor(now / 600)) % 3) * 6, 2)
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x + 13, y + 53, 42, 32)
      ctx.fillStyle = '#326174'
      for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 17, y + 57 + i * 7, 34, 2)
      ctx.fillStyle = LED_AMBER
      ctx.fillRect(x + 27, y + 93, 16, 3)
      drawMapBeacon(ctx, x + 33, y - 6, now, seed)
    }

    // 冷却区：储液罐、管道和上浮气泡。
    function drawMapCoolantTank(ctx, x, now, seed) {
      const y = 57
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x + 4, y - 8, 59, 12)
      ctx.fillRect(x + 5, y + 2, 57, 114)
      ctx.fillStyle = METAL_HI
      ctx.fillRect(x + 5, y + 2, 4, 114)
      ctx.fillRect(x + 58, y + 2, 4, 114)
      ctx.fillStyle = '#0c2637'
      ctx.fillRect(x + 12, y + 9, 43, 96)
      ctx.fillStyle = '#174e61'
      ctx.fillRect(x + 14, y + 29, 39, 73)
      const wave = Math.round(Math.sin(now / 500 + seed) * 2)
      ctx.fillStyle = '#48acc5'
      ctx.fillRect(x + 14, y + 29 + wave, 39, 2)
      ctx.fillStyle = '#81e1ed'
      for (let i = 0; i < 5; i += 1) {
        const by = y + 98 - ((Math.floor(now / 150) + i * 18 + seed * 3) % 65)
        const bx = x + 19 + ((i * 9 + seed * 5) % 27)
        ctx.fillRect(bx, by, i % 2 === 0 ? 2 : 1, 2)
      }
      ctx.fillStyle = METAL
      ctx.fillRect(x - 5, y + 14, 12, 7)
      ctx.fillRect(x + 60, y + 70, 14, 7)
      ctx.fillStyle = LED_BLUE
      ctx.fillRect(x + 20, y + 111, 28, 2)
    }

    // 核心区：带呼吸光的密封舱和警示灯。
    function drawMapContainment(ctx, x, now, seed) {
      const y = 49
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(x - 6, y, 80, 126)
      ctx.fillStyle = METAL
      ctx.fillRect(x - 3, y + 4, 6, 119)
      ctx.fillRect(x + 65, y + 4, 6, 119)
      ctx.fillStyle = '#081824'
      ctx.fillRect(x + 4, y + 7, 60, 110)
      ctx.fillStyle = '#21465d'
      ctx.fillRect(x + 14, y + 12, 40, 100)
      const alpha = ctx.globalAlpha
      ctx.globalAlpha = alpha * (0.20 + Math.abs(Math.sin(now / 410 + seed)) * 0.22)
      ctx.fillStyle = CYAN
      ctx.fillRect(x + 14, y + 17, 40, 90)
      ctx.globalAlpha = alpha
      ctx.fillStyle = '#8cf6ea'
      ctx.fillRect(x + 31, y + 20, 6, 82)
      ctx.fillStyle = '#d6fffa'
      ctx.fillRect(x + 33, y + 26, 2, 70)
      ctx.fillStyle = METAL_HI
      for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 7, y + 23 + i * 27, 55, 3)
      drawMapBeacon(ctx, x + 34, y - 5, now, seed)
    }

    // 真实世界坐标 300m 的气闸地标，不会在换区瞬间跳出来。
    function drawMapAirlock(ctx, x, now, sector) {
      const y = 51
      ctx.fillStyle = '#081925'
      ctx.fillRect(x - 5, y, 80, 124)
      ctx.fillStyle = METAL
      ctx.fillRect(x - 5, y, 8, 124)
      ctx.fillRect(x + 67, y, 8, 124)
      ctx.fillRect(x - 5, y, 80, 8)
      ctx.fillStyle = '#174057'
      ctx.fillRect(x + 9, y + 12, 52, 112)
      ctx.fillStyle = '#061a27'
      ctx.fillRect(x + 15, y + 16, 40, 108)
      ctx.fillStyle = '#3e7180'
      ctx.fillRect(x + 33, y + 16, 2, 108)
      const accent = sector === 1 ? LED_BLUE : sector === 2 ? LED_RED : LED_AMBER
      ctx.fillStyle = accent
      for (let i = 0; i < 5; i += 1) {
        ctx.fillRect(x - 2, y + 23 + i * 20, 4, 4)
        ctx.fillRect(x + 68, y + 23 + i * 20, 4, 4)
      }
      ctx.fillRect(x + 19, y + 4, 31, 2)
      ctx.fillStyle = '#c0eced'
      ctx.fillRect(x + 27, y + 4, 15, 1)
    }

    function drawMapSetpieces(ctx, worldX, now) {
      // 与障碍一样锚定世界坐标；每段房间更换后不会出现屏幕贴图跳变。
      const unit = 460
      const first = Math.floor(worldX / unit) - 1
      for (let i = first; i <= first + 3; i += 1) {
        const worldMid = (i + 0.5) * unit
        if (worldMid < 0) continue
        const x = Math.round(worldMid - worldX - 36)
        if (x < -100 || x > VIEW_W + 85) continue
        const segment = mapSegmentOf(worldMid / 10)
        if (segment.slot === 3) continue
        if (segment.sector === 0) drawMapSecurityBay(ctx, x, now, i)
        else if (segment.sector === 1) drawMapCoolantTank(ctx, x, now, i)
        else drawMapContainment(ctx, x, now, i)
      }
      const boundary = SECTOR_LENGTH * 10
      const firstBoundary = Math.max(1, Math.floor(worldX / boundary))
      for (let n = firstBoundary; n <= firstBoundary + 1; n += 1) {
        const x = Math.round(n * boundary - worldX - 35)
        if (x > -100 && x < VIEW_W + 100) drawMapAirlock(ctx, x, now, (n - 1) % 3)
      }
    }

    function drawMapFloorMarkers(ctx, worldX) {
      const unit = MAP_CHUNK_LENGTH * 10
      const first = Math.floor(worldX / unit)
      for (let i = first; i <= first + 1; i += 1) {
        const x = Math.round(i * unit - worldX)
        if (x < -9 || x > VIEW_W + 9) continue
        ctx.fillStyle = '#162a38'
        ctx.fillRect(x - 2, GROUND_Y + 7, 6, 17)
        ctx.fillStyle = CYAN_DIM
        ctx.fillRect(x - 2, GROUND_Y + 7, 6, 2)
        ctx.fillRect(x, GROUND_Y + 15, 2, 4)
      }
    }

    function drawSectorBack(ctx, sector, worldX, now, opacity = 1) {
      if (opacity <= 0) return
      ctx.save()
      ctx.globalAlpha = opacity
      if (sector === 0) {
        // 远景机架剪影，拉开纵深
        const farOffset = -((worldX * 0.1) % 130)
        ctx.globalAlpha = opacity * 0.45
        for (let i = 0; i < 5; i += 1) {
          const x = Math.round(farOffset + i * 130)
          ctx.fillStyle = '#0e2333'
          ctx.fillRect(x, 58, 52, GROUND_Y - 58)
          ctx.fillStyle = 'rgba(103,232,214,.12)'
          for (let j = 0; j < 4; j += 1) ctx.fillRect(x + 6, 66 + j * 13, 2, 2)
        }
        ctx.globalAlpha = opacity
        // 主层：玻璃机房 / 机架组 / 安全门，交替出现
        const period = 300
        const base = Math.floor((worldX * 0.22) / period)
        const offset = -((worldX * 0.22) % period)
        for (let i = 0; i < 5; i += 1) {
          const idx = base + i
          const x = Math.round(offset + i * period)
          if (idx % 3 === 0) drawGlassRoom(ctx, x, 46, 154, GROUND_Y - 46, idx, now)
          else if (idx % 3 === 1) drawServerBank(ctx, x, 52, idx, now)
          else drawBulkheadDoor(ctx, x + 14, 54, 92, GROUND_Y - 54, idx, now)
        }
        // 墙面状态屏
        const screenOffset = -((worldX * 0.18) % 620)
        for (let i = 0; i < 2; i += 1) drawWallScreen(ctx, Math.round(screenOffset + i * 620 + 240), 44, now, i + 1)
      } else if (sector === 1) {
        // 冷却区：横贯管廊 + 风扇墙 / 管件 / 控制室
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(0, 45, VIEW_W, 16)
        ctx.fillStyle = METAL
        ctx.fillRect(0, 45, VIEW_W, 2)
        ctx.fillRect(0, 59, VIEW_W, 2)
        const jointOffset = -((worldX * 0.26) % 96)
        for (let i = 0; i < 5; i += 1) {
          const x = Math.round(jointOffset + i * 96)
          ctx.fillStyle = METAL_HI
          ctx.fillRect(x, 42, 10, 22)
          ctx.fillStyle = METAL_DARK
          ctx.fillRect(x + 2, 46, 6, 14)
        }
        const period = 280
        const base = Math.floor((worldX * 0.24) / period)
        const offset = -((worldX * 0.24) % period)
        for (let i = 0; i < 4; i += 1) {
          const idx = base + i
          const x = Math.round(offset + i * period)
          if (idx % 3 === 0) drawFanWall(ctx, x, 64, idx, now)
          else if (idx % 3 === 1) drawPipeJunction(ctx, x + 18, 62, idx, now)
          else drawGlassRoom(ctx, x, 66, 112, GROUND_Y - 66, idx, now)
        }
        ctx.globalAlpha = opacity * 0.06
        ctx.fillStyle = LED_BLUE
        ctx.fillRect(0, GROUND_Y - 24, VIEW_W, 24)
        ctx.globalAlpha = opacity
      } else {
        // 核心区：变压器柜、发光核心柱、导管墙
        const farOffset = -((worldX * 0.1) % 170)
        ctx.globalAlpha = opacity * 0.4
        for (let i = 0; i < 4; i += 1) {
          const x = Math.round(farOffset + i * 170)
          ctx.fillStyle = '#0c1d29'
          ctx.fillRect(x, 52, 78, GROUND_Y - 52)
        }
        ctx.globalAlpha = opacity
        const period = 300
        const base = Math.floor((worldX * 0.24) / period)
        const offset = -((worldX * 0.24) % period)
        for (let i = 0; i < 4; i += 1) {
          const idx = base + i
          const x = Math.round(offset + i * period)
          if (idx % 3 === 0) drawTransformer(ctx, x + 16, 52, idx, now)
          else if (idx % 3 === 1) drawCoreColumn(ctx, x, 44, idx, now)
          else drawConduitWall(ctx, x + 20, 52, idx, now)
        }
        // 红色应急灯带
        const alarmOffset = -((worldX * 0.22) % 260)
        for (let i = 0; i < 2; i += 1) {
          const x = Math.round(alarmOffset + i * 260 + 120)
          const on = Math.floor(now / 420 + i) % 4 !== 0
          ctx.fillStyle = on ? LED_RED : '#42181b'
          ctx.fillRect(x, 36, 3, 2)
        }
      }
      // EXIT 安全出口标志
      const signOffset = -((worldX * 0.4) % 360)
      for (let i = 0; i < 3; i += 1) {
        drawExitSign(ctx, Math.round(signOffset + i * 360 + 120), 32, now)
      }
      ctx.restore()
    }

    function drawCeiling(ctx, worldX, now) {
      ctx.fillStyle = CEIL
      ctx.fillRect(0, 0, VIEW_W, 32)
      ctx.fillStyle = PANEL
      ctx.fillRect(0, 29, VIEW_W, 4)
      // 顶部送风管
      ctx.fillStyle = '#0b1824'
      ctx.fillRect(0, 0, VIEW_W, 10)
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(0, 9, VIEW_W, 2)
      const ductOffset = -((worldX * 0.45) % 120)
      for (let i = 0; i < 4; i += 1) {
        const x = Math.round(ductOffset + i * 120)
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(x, 0, 86, 8)
        ctx.fillStyle = '#15293a'
        for (let j = 0; j < 6; j += 1) ctx.fillRect(x + 8 + j * 12, 3, 5, 1)
        ctx.fillStyle = METAL
        ctx.fillRect(x, 0, 2, 8)
      }
      // 线缆桥架 + 支架
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(0, 17, VIEW_W, 4)
      ctx.fillStyle = METAL
      ctx.fillRect(0, 17, VIEW_W, 1)
      const bracketOffset = -((worldX * 0.5) % 80)
      for (let i = 0; i < 6; i += 1) ctx.fillRect(Math.round(bracketOffset + i * 80), 14, 2, 10)
      // 吊灯
      const lightOffset = -((worldX * 0.5) % 160)
      for (let i = 0; i < 3; i += 1) {
        drawLightStrip(ctx, Math.round(lightOffset + i * 160 + 30), 6, 88, now, i + 1)
      }
      // 悬挂指示牌
      const signOffset = -((worldX * 0.62) % 460)
      for (let i = 0; i < 2; i += 1) {
        const x = Math.round(signOffset + i * 460 + 90)
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(x, 20, 2, 7)
        ctx.fillRect(x + 26, 20, 2, 7)
        ctx.fillStyle = '#0b1a24'
        ctx.fillRect(x - 3, 26, 34, 12)
        ctx.fillStyle = CYAN_DIM
        ctx.fillRect(x + 2, 30, 14, 2)
        ctx.fillRect(x + 20, 30, 8, 2)
        ctx.fillStyle = LED_GREEN
        ctx.fillRect(x + 26, 29, 2, 4)
      }
      // 垂下的线缆 + 监控
      const cableOffset = -((worldX * 0.75) % 230)
      for (let i = 0; i < 3; i += 1) {
        const x = Math.round(cableOffset + i * 230 + 70)
        const sway = Math.round(Math.sin(now / 1000 + i) * 2)
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(x, 21, 1, 24)
        ctx.fillRect(x + sway, 45, 1, 13)
        ctx.fillRect(x - 2 + sway, 58, 4, 3)
        ctx.fillStyle = METAL
        ctx.fillRect(x - 2 + sway, 58, 4, 1)
        if (i === 1) drawSecurityCamera(ctx, x + 16, 26, now)
      }
    }

    function drawFloorSectorDetail(ctx, worldX, now, sector, opacity = 1) {
      if (opacity <= 0) return
      ctx.save()
      ctx.globalAlpha = opacity
      // 区域专属地面
      if (sector === 0) {
        const portOffset = -((worldX * 0.9) % 260)
        for (let i = 0; i < 2; i += 1) {
          const x = Math.round(portOffset + i * 260 + 80)
          ctx.fillStyle = '#0b141c'
          ctx.fillRect(x, GROUND_Y + 22, 30, 6)
          ctx.fillStyle = CYAN_DIM
          ctx.fillRect(x + 2, GROUND_Y + 24, 26, 1)
          ctx.fillStyle = METAL
          for (let j = 0; j < 3; j += 1) ctx.fillRect(x + 5 + j * 8, GROUND_Y + 23, 2, 1)
        }
      } else if (sector === 1) {
        ctx.globalAlpha = opacity * 0.12
        ctx.fillStyle = LED_BLUE
        const puddleOffset = -((worldX * 1.1) % 300)
        for (let i = 0; i < 3; i += 1) {
          const x = Math.round(puddleOffset + i * 300 + 40)
          ctx.fillRect(x, GROUND_Y + 12, 54, 3)
          ctx.fillRect(x + 8, GROUND_Y + 15, 30, 1)
        }
        ctx.globalAlpha = opacity
        // 冷却区格栅
        const grateOffset = -((worldX * 1.2) % 220)
        for (let i = 0; i < 3; i += 1) {
          const x = Math.round(grateOffset + i * 220 + 100)
          ctx.fillStyle = '#152a38'
          ctx.fillRect(x, GROUND_Y + 20, 36, 5)
          ctx.fillStyle = '#2f657c'
          for (let j = 0; j < 5; j += 1) ctx.fillRect(x + 3 + j * 7, GROUND_Y + 21, 1, 3)
        }
      } else {
        const channelOffset = -((worldX * 1.05) % 200)
        for (let i = 0; i < 3; i += 1) {
          const x = Math.round(channelOffset + i * 200 + 30)
          const pulse = 0.18 + Math.abs(Math.sin(now / 420 + i)) * 0.22
          ctx.globalAlpha = opacity * pulse
          ctx.fillStyle = CYAN
          ctx.fillRect(x, GROUND_Y + 14, 46, 2)
          ctx.globalAlpha = opacity
          ctx.fillStyle = '#142633'
          ctx.fillRect(x, GROUND_Y + 17, 46, 2)
        }
      }
      ctx.restore()
    }

    function drawFloor(ctx, worldX, now, sector, blend) {
      ctx.fillStyle = FLOOR
      ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y)
      // 地面导光带
      const stripOffset = -((worldX) % 120)
      for (let i = 0; i < 5; i += 1) {
        const x = Math.round(stripOffset + i * 120 + 12)
        ctx.fillStyle = CYAN
        ctx.fillRect(x, GROUND_Y, 42, 1)
        ctx.globalAlpha = 0.12
        ctx.fillStyle = CYAN
        ctx.fillRect(x, GROUND_Y + 1, 42, 3)
        ctx.globalAlpha = 1
      }
      // 抛光地砖
      const tileOffset = -((worldX) % 44)
      for (let i = 0; i < 12; i += 1) {
        const x = Math.round(tileOffset + i * 44)
        const dark = (Math.floor(worldX / 44) + i) % 2 === 0
        ctx.fillStyle = dark ? FLOOR_TILE : FLOOR
        ctx.fillRect(x, GROUND_Y + 2, 43, VIEW_H - GROUND_Y - 2)
        ctx.fillStyle = '#1b3546'
        ctx.fillRect(x + 43, GROUND_Y + 2, 1, VIEW_H - GROUND_Y - 2)
        ctx.fillRect(x + 1, GROUND_Y + 30, 41, 1)
        if ((i + Math.floor(worldX / 44)) % 5 === 0) {
          ctx.fillStyle = '#0b141c'
          ctx.fillRect(x + 10, GROUND_Y + 16, 8, 2)
          ctx.fillRect(x + 28, GROUND_Y + 24, 3, 1)
        }
      }
      if (blend) {
        drawFloorSectorDetail(ctx, worldX, now, blend.from, 1 - blend.mix)
        drawFloorSectorDetail(ctx, worldX, now, blend.to, blend.mix)
      } else {
        drawFloorSectorDetail(ctx, worldX, now, sector)
      }
      // 地面蒸汽口
      const ventOffset = -((worldX) % 330)
      for (let i = 0; i < 3; i += 1) drawSteamVent(ctx, Math.round(ventOffset + i * 330 + 150), now, sector === 1 ? 1.4 : 0.8)
      // 逃生指示箭头
      const arrowOffset = -((worldX * 1.05) % 200)
      ctx.fillStyle = 'rgba(103,232,214,.28)'
      for (let i = 0; i < 3; i += 1) {
        const ax = Math.round(arrowOffset + i * 200 + 30)
        const ay = GROUND_Y + 12
        ctx.fillRect(ax, ay, 10, 2)
        ctx.fillRect(ax + 8, ay - 2, 2, 2)
        ctx.fillRect(ax + 8, ay + 2, 2, 2)
      }
      // 顶部反光
      const reflectOffset = -((worldX * 0.5) % 160)
      ctx.globalAlpha = 0.05
      ctx.fillStyle = WHITE_LIGHT
      for (let i = 0; i < 3; i += 1) {
        const x = Math.round(reflectOffset + i * 160 + 48)
        ctx.fillRect(x, GROUND_Y + 2, 52, VIEW_H - GROUND_Y - 2)
      }
      ctx.globalAlpha = 1
    }

    function drawForeground(ctx, worldX, now) {
      // 悬垂数据线
      const cableOffset = -((worldX * 0.9) % 270)
      for (let i = 0; i < 2; i += 1) {
        const x = Math.round(cableOffset + i * 270 + 40)
        const sway = Math.round(Math.sin(now / 700 + i * 2) * 2)
        ctx.fillStyle = '#0a1620'
        ctx.fillRect(x + sway, 32, 2, 22)
        ctx.fillRect(x - 1 + sway, 53, 4, 3)
        ctx.fillStyle = METAL
        ctx.fillRect(x - 1 + sway, 53, 4, 1)
      }
      // 漂浮数据粒子
      for (let i = 0; i < 10; i += 1) {
        const x = (i * 73 + Math.round(worldX * 0.3)) % VIEW_W
        const y = 38 + ((i * 41 + Math.floor(now / 50)) % 132)
        ctx.fillStyle = i % 3 === 0 ? WHITE_LIGHT : CYAN_DIM
        ctx.fillRect(x, y, 1, 1)
      }
    }

    function drawBackground(ctx, game, now) {
      const worldX = game.distance * 10
      const sector = mapSegmentOf(game.distance).sector
      const blend = sectorBlendOf(game.distance)
      // 墙面基础色（上暗下亮，做出机房纵深）
      const wallTop = 30
      const bandH = Math.ceil((GROUND_Y - wallTop) / SKY.length)
      for (let i = 0; i < SKY.length; i += 1) {
        ctx.fillStyle = SKY[i]
        ctx.fillRect(0, wallTop + i * bandH, VIEW_W, bandH + 1)
      }
      // 墙面竖向拼缝
      const panelOffset = -((worldX * 0.18) % 96)
      ctx.fillStyle = 'rgba(20,39,56,.55)'
      for (let i = 0; i < 6; i += 1) ctx.fillRect(Math.round(panelOffset + i * 96), wallTop, 1, GROUND_Y - wallTop)
      if (blend) {
        drawSectorBack(ctx, blend.from, worldX, now, 1 - blend.mix)
        drawSectorBack(ctx, blend.to, worldX, now, blend.mix)
      } else {
        drawSectorBack(ctx, sector, worldX, now)
      }
      drawMapSetpieces(ctx, worldX, now)
      drawMapExtraProps(ctx, worldX)
      drawFloor(ctx, worldX, now, sector, blend)
      drawMapFloorMarkers(ctx, worldX)
      drawCeiling(ctx, worldX, now)
      drawForeground(ctx, worldX, now)
      drawPlayfieldContrast(ctx)
    }

    function drawToken(ctx, token, now) {
      // 独立的 10px 金币视觉体系，取消青色方形光晕；图案奖励用粉金中心。
      const x = Math.round(token.x)
      const y = Math.round(token.y + (token.kind === 'bonus' ? Math.sin(now / 260 + token.phase) : 0))
      const outer = TOKEN.edge
      ctx.fillStyle = outer
      ctx.fillRect(x - 3, y - 5, 6, 1)
      ctx.fillRect(x - 5, y - 3, 10, 6)
      ctx.fillRect(x - 3, y + 3, 6, 2)
      ctx.fillStyle = TOKEN.main
      ctx.fillRect(x - 3, y - 4, 6, 8)
      ctx.fillRect(x - 4, y - 3, 8, 6)
      ctx.fillStyle = TOKEN.dark
      ctx.fillRect(x + 2, y - 3, 1, 6)
      ctx.fillRect(x - 2, y + 3, 4, 1)
      ctx.fillStyle = TOKEN.hi
      ctx.fillRect(x - 2, y - 3, 3, 2)
      ctx.fillStyle = token.kind === 'bonus' ? TOKEN.bonus : TOKEN.dark
      ctx.fillRect(x - 1, y - 1, 2, 3)
      ctx.fillRect(x - 2, y, 4, 1)
    }

    function drawObstacle(ctx, obstacle, now) {
      const x = Math.round(obstacle.x)
      const width = obstacle.type === 'low' ? LOW_W : HIGH_W
      const lowTop = GROUND_Y - LOW_H
      ctx.fillStyle = 'rgba(0,0,0,.35)'
      ctx.fillRect(x - 5, GROUND_Y - 2, width + 10, 6)
      if (obstacle.type === 'low') {
        // 低障碍固定黄橙色：厚黑描边、强高光和独立警示图标。
        ctx.fillStyle = '#080d14'
        ctx.fillRect(x - 3, lowTop - 3, LOW_W + 6, LOW_H + 6)
        ctx.fillStyle = '#dd8a27'
        ctx.fillRect(x, lowTop, LOW_W, LOW_H)
        ctx.fillStyle = '#ffca55'
        ctx.fillRect(x + 2, lowTop + 2, LOW_W - 4, LOW_H - 5)
        ctx.fillStyle = '#ffeca3'
        ctx.fillRect(x + 3, lowTop + 3, LOW_W - 6, 3)
        ctx.fillStyle = '#5b321e'
        for (let i = 0; i < 3; i += 1) ctx.fillRect(x + 4 + i * 8, lowTop + 9, 4, 5)
        ctx.fillStyle = '#c36a1f'
        ctx.fillRect(x + 2, GROUND_Y - 5, LOW_W - 4, 3)
        ctx.fillStyle = '#11151c'
        for (let i = 0; i < 4; i += 1) ctx.fillRect(x + 4 + i * 6, GROUND_Y - 5, 3, 3)
        // 小警示牌位于障碍上方；不与跳跃金币的抛物线重叠。
        ctx.fillStyle = '#08131c'
        ctx.fillRect(x + 10, lowTop - 16, 10, 11)
        ctx.fillStyle = '#ffd15a'
        ctx.fillRect(x + 12, lowTop - 14, 6, 7)
        ctx.fillStyle = '#33221a'
        ctx.fillRect(x + 14, lowTop - 13, 2, 3)
        ctx.fillRect(x + 14, lowTop - 9, 2, 1)
      } else {
        // 高障碍仅用鲜红激光 + 向下箭头来表达「滑铲」，远离背景青色状态灯。
        const top = HIGH_TOP
        const bottom = HIGH_BOTTOM
        ctx.fillStyle = '#080c15'
        ctx.fillRect(x - 8, top - 12, HIGH_W + 16, 7)
        ctx.fillRect(x - 5, top - 5, 7, bottom - top + 13)
        ctx.fillRect(x + HIGH_W - 2, top - 5, 7, bottom - top + 13)
        ctx.fillStyle = '#52626e'
        ctx.fillRect(x - 6, top - 9, HIGH_W + 12, 3)
        ctx.fillRect(x - 3, top - 3, 4, bottom - top + 8)
        ctx.fillRect(x + HIGH_W - 1, top - 3, 4, bottom - top + 8)
        ctx.fillStyle = '#a9b6bd'
        ctx.fillRect(x - 2, top - 2, 2, bottom - top + 6)
        ctx.fillRect(x + HIGH_W, top - 2, 2, bottom - top + 6)
        const alpha = ctx.globalAlpha
        ctx.globalAlpha = alpha * (0.20 + Math.abs(Math.sin(now / 260)) * 0.12)
        ctx.fillStyle = '#ff3b55'
        ctx.fillRect(x - 3, bottom - 5, HIGH_W + 6, 11)
        ctx.globalAlpha = alpha
        ctx.fillStyle = '#ff2d45'
        ctx.fillRect(x, bottom - 2, HIGH_W, 4)
        ctx.fillStyle = '#ffe6e9'
        ctx.fillRect(x + 1, bottom - 1, HIGH_W - 2, 1)
        // 红色向下箭头与高位危险区同色；离 token 的低位路线留白。
        const mid = x + Math.floor(HIGH_W / 2)
        ctx.fillStyle = '#080c15'
        ctx.fillRect(mid - 7, top - 21, 14, 10)
        ctx.fillStyle = '#ff6673'
        ctx.fillRect(mid - 1, top - 20, 3, 5)
        ctx.fillRect(mid - 4, top - 16, 9, 2)
        ctx.fillRect(mid - 2, top - 14, 5, 2)
      }
    }

    function laserBlink(now) {
      return Math.floor(now / 240) % 4 !== 0
    }

    let clawdRunSprite = null
    let clawdSlideSprite = null
    function getClawdSprite(sliding) {
      if (typeof Image === 'undefined') return null
      if (sliding) {
        if (!clawdSlideSprite) {
          clawdSlideSprite = new Image()
          clawdSlideSprite.src = CLAWD_SLIDE_SHEET
        }
        return clawdSlideSprite
      }
      if (!clawdRunSprite) {
        clawdRunSprite = new Image()
        clawdRunSprite.src = CLAWD_RUN_SHEET
      }
      return clawdRunSprite
    }

    /** Clawd 直接使用用户提供的 running / sliding 精灵表。 */
    function drawClawd(ctx, game, now) {
      const player = game.player
      const x = PLAYER_X
      const feet = Math.round(GROUND_Y + player.y)
      const sliding = player.sliding
      const airborne = player.y < 0
      const sprite = getClawdSprite(sliding)
      const frameW = sliding ? CLAWD_SLIDE_FRAME_W : CLAWD_RUN_FRAME_W
      const frameH = sliding ? CLAWD_SLIDE_FRAME_H : CLAWD_RUN_FRAME_H
      const height = sliding ? 28 : 36
      const width = Math.round((frameW * height) / frameH)
      // 地面投影
      ctx.fillStyle = '#061018'
      if (airborne) {
        const shrink = Math.min(12, Math.round(-player.y * 0.15))
        ctx.fillRect(x - 12 + shrink, GROUND_Y + 1, 24 - shrink * 2, 2)
      } else {
        ctx.fillRect(x - Math.round(width * 0.32), GROUND_Y + 1, Math.round(width * 0.64), 2)
      }
      if (!sprite || !sprite.complete || !sprite.naturalWidth) return
      const blinking = player.invuln > 0 && Math.floor(now / 110) % 2 === 0
      const left = x - Math.round(width / 2)
      let frame
      if (sliding) {
        // gif 的第 0~3 帧是起身/过渡，不适合作为启动动作；裁切后只保留 #4~#7，从 #4 起播。
        const elapsed = Math.max(0, SLIDE_TIME - player.slideTimer)
        frame = Math.floor(elapsed / 0.09) % CLAWD_SLIDE_FRAMES
      } else {
        frame = Math.floor(game.time / 0.08) % CLAWD_FRAMES
      }
      const top = feet + 2 - height
      ctx.drawImage(sprite, frame * frameW, 0, frameW, frameH, left, top, width, height)
      if (blinking) {
        ctx.fillStyle = '#ffffff'
        const arm = 5
        ctx.fillRect(left - 2, top - 2, arm, 1)
        ctx.fillRect(left - 2, top - 2, 1, arm)
        ctx.fillRect(left + width + 1 - arm, top - 2, arm, 1)
        ctx.fillRect(left + width + 1, top - 2, 1, arm)
        ctx.fillRect(left - 2, top + height + 1, arm, 1)
        ctx.fillRect(left - 2, top + height + 1 - arm + 1, 1, arm)
        ctx.fillRect(left + width + 1 - arm, top + height + 1, arm, 1)
        ctx.fillRect(left + width + 1, top + height + 1 - arm + 1, 1, arm)
      }
    }

    let darioSprite = null
    function getDarioSprite() {
      if (!darioSprite && typeof Image !== 'undefined') {
        darioSprite = new Image()
        darioSprite.src = DARIO_SHEET
      }
      return darioSprite
    }

    /** 达里奥使用用户提供的 Running-Dario.gif 拆帧精灵表。 */
    function drawDario(ctx, game, now) {
      const x = Math.round(PLAYER_X - game.gap)
      if (x < -80) return
      const height = game.gap < 35 ? 66 : 60
      const width = Math.round((DARIO_FRAME_W * height) / DARIO_FRAME_H)
      ctx.fillStyle = '#061018'
      ctx.fillRect(x - Math.round(width * 0.3), GROUND_Y + 1, Math.round(width * 0.6), 2)
      const sprite = getDarioSprite()
      if (!sprite || !sprite.complete || !sprite.naturalWidth) return
      const frame = Math.floor(game.time / 0.08) % DARIO_FRAMES
      ctx.drawImage(
        sprite,
        frame * DARIO_FRAME_W, 0, DARIO_FRAME_W, DARIO_FRAME_H,
        x - Math.round(width / 2), GROUND_Y + 2 - height,
        width, height,
      )
    }

    function drawParticles(ctx, game) {
      for (const particle of game.particles) {
        ctx.fillStyle = particle.kind === 'token' ? TOKEN.hi : DUST
        const size = particle.life > 0.22 ? 2 : 1
        ctx.fillRect(Math.round(particle.x), Math.round(particle.y), size, size)
      }
    }

    function drawFrame(ctx, game, now) {
      const shake = game.shake > 0 ? game.shake : 0
      ctx.imageSmoothingEnabled = false
      ctx.save()
      if (shake > 0) {
        ctx.translate(Math.round(Math.sin(now * 0.09) * shake), Math.round(Math.cos(now * 0.13) * shake))
      }
      drawBackground(ctx, game, now)
      if (game.status === 'ready') {
        // 开始页只留机房环境，不出现 Clawd/达里奥/障碍，避免像已经开始游戏。
        ctx.restore()
        return
      }
      for (const token of game.tokensList) drawToken(ctx, token, now)
      for (const obstacle of game.obstacles) drawObstacle(ctx, obstacle, now)
      drawDario(ctx, game, now)
      drawClawd(ctx, game, now)
      drawParticles(ctx, game)
      ctx.restore()
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    const CSS = [
      '.cr-page{height:100%;min-height:0;overflow:auto;display:flex;padding:14px 18px 18px;box-sizing:border-box;background:transparent}',
      '.cr-shell{margin:auto;width:min(100%,1240px);display:flex;flex-direction:column;gap:10px}',
      '.cr-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.cr-brand{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.cr-wordmark{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.cr-logo{display:flex;flex:0 0 auto}',
      '.cr-title{font-size:28px;font-weight:850;line-height:1.05;letter-spacing:.03em;color:var(--dsw-alias-label-primary,#f2faf8)}',
      '.cr-sub{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#8fa8b5)}',
      '.cr-sector{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:4px;border:1px solid rgba(103,232,214,.45);background:#0b1a26;font-size:10px;letter-spacing:.08em;color:#9ff5e8;vertical-align:1px;font-variant-numeric:tabular-nums}',
      '.cr-stats{display:flex;gap:7px;flex-wrap:wrap}',
      '.cr-stat{min-width:64px;padding:7px 10px;border-radius:9px;box-sizing:border-box;text-align:center;background:linear-gradient(180deg,#0e2230,#0a1822);border:1px solid rgba(120,180,200,.2);box-shadow:0 2px 8px rgba(0,0,0,.16)}',
      '.cr-stat.is-best{border-color:rgba(183,212,154,.24)}',
      '.cr-stat.is-token{border-color:rgba(103,232,214,.3)}',
      '.cr-stat-k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:#9fb6c2}',
      '.cr-stat-v{font-size:17px;font-weight:800;line-height:1.25;font-variant-numeric:tabular-nums;color:#f2faf8}',
      '.cr-stat.is-best .cr-stat-v{color:#b7d49a}',
      '.cr-stat.is-token .cr-stat-v{color:#67e8d6}',
      '.cr-chase{display:flex;align-items:center;gap:10px;padding:7px 11px;border-radius:10px;box-sizing:border-box;background:#0c1c27;border:1px solid rgba(120,180,200,.24)}',
      '.cr-chase-label{flex:0 0 auto;font-size:11px;font-weight:700;letter-spacing:.08em;color:#9fb6c2}',
      '.cr-chase-track{flex:1 1 auto;height:8px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.16)}',
      '.cr-chase-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#67e8d6,#3f9d8b);transition:width 120ms linear,background 200ms ease}',
      '.cr-chase.is-warn .cr-chase-fill{background:linear-gradient(90deg,#f2c14e,#c98c22)}',
      '.cr-chase.is-danger .cr-chase-fill{background:linear-gradient(90deg,#f25f5c,#a63b3b)}',
      '.cr-chase-pct{flex:0 0 auto;min-width:38px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:#9fb6c2}',
      '.cr-aquarium{position:relative;width:100%;box-sizing:border-box;padding:10px;border-radius:18px;background:linear-gradient(180deg,#0a1c28,#06121b);border:1px solid rgba(120,190,210,.2);box-shadow:0 24px 52px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.05)}',
      '.cr-screen-slot{position:relative;display:flex;justify-content:center;align-items:center;width:100%;min-height:120px}',
      '.cr-canvas{display:block;image-rendering:pixelated;background:#06121b;border-radius:7px;touch-action:none;user-select:none;-webkit-user-select:none;box-shadow:0 0 34px rgba(70,180,200,.1),inset 0 0 0 1px rgba(120,200,210,.12);cursor:pointer}',
      '.cr-page:fullscreen{height:100vh;padding:10px 14px;background:#07131d;box-sizing:border-box}',
      '.cr-page:fullscreen .cr-shell{width:min(100%,1600px)}',
      '.cr-overlay{position:absolute;inset:10px;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(3,9,14,.72);border-radius:8px;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:cr-fade 160ms ease-out}',
      '@keyframes cr-fade{from{opacity:0}to{opacity:1}}',
      '.cr-card{display:flex;flex-direction:column;align-items:center;gap:9px;width:min(100%,390px);padding:22px 20px 18px;box-sizing:border-box;text-align:center;border-radius:14px;background:linear-gradient(180deg,#0d2130,#081722);border:1px solid rgba(120,180,200,.26);box-shadow:0 18px 50px rgba(0,0,0,.45);animation:cr-card-in 190ms cubic-bezier(.2,.75,.3,1)}',
      '@keyframes cr-card-in{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '.cr-card-kicker{font-size:9px;font-weight:800;letter-spacing:.2em;color:#67e8d6;text-transform:uppercase}',
      '.cr-card-title{font-size:27px;font-weight:900;line-height:1.12;letter-spacing:.02em;color:#f2faf8}',
      '.cr-card-note{max-width:300px;font-size:12px;line-height:1.65;color:#9fb6c2}',
      '.cr-card-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;width:100%;margin-top:6px}',
      '.cr-card-stat{padding:8px 6px;border-radius:9px;border:1px solid rgba(120,180,200,.16);background:#091923;box-sizing:border-box}',
      '.cr-card-stat-k{font-size:8px;letter-spacing:.12em;color:#8fa8b5;text-transform:uppercase}',
      '.cr-card-stat-v{font-size:17px;font-weight:850;line-height:1.25;color:#f2faf8;font-variant-numeric:tabular-nums}',
      '.cr-card-rank{display:inline-block;margin-top:2px;padding:4px 10px;border-radius:999px;border:1px solid rgba(232,135,90,.4);background:rgba(232,135,90,.1);color:#f2b18f;font-size:11px;font-weight:800;letter-spacing:.06em}',
      '.cr-card-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-top:7px}',
      '.cr-card .cr-btn:not(.is-primary){background:#0d2130;border-color:rgba(140,200,220,.22);color:#dce9ed}',
      '.cr-card .cr-btn:not(.is-primary):hover:not(:disabled){background:#133141;border-color:rgba(140,200,220,.42)}',
      '.cr-overlay-start{inset:0;padding:0;border-radius:0;background:linear-gradient(180deg,rgba(3,9,14,.55),rgba(3,9,14,.95));backdrop-filter:blur(1.2px);-webkit-backdrop-filter:blur(1.2px)}',
      '.cr-start{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:24px 28px;box-sizing:border-box;overflow:auto}',
      '.cr-start:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(103,232,214,.03) 1px,transparent 1px),linear-gradient(90deg,rgba(103,232,214,.03) 1px,transparent 1px);background-size:32px 32px;pointer-events:none}',
      '.cr-start-inner{position:relative;z-index:1;width:min(100%,980px);display:grid;grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr);gap:28px;align-items:center}',
      '.cr-start-main{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.cr-start-kicker{display:flex;align-items:center;gap:8px;font-size:9.5px;font-weight:800;letter-spacing:.24em;color:#67e8d6;text-transform:uppercase}',
      '.cr-start-dot{width:6px;height:6px;border-radius:50%;background:#67e8d6;box-shadow:0 0 9px #67e8d6}',
      '.cr-start-title{margin:0;font-size:clamp(40px,5.4vw,62px);font-weight:900;line-height:.98;letter-spacing:.015em;color:#f2faf8}',
      '.cr-start-title .cr-title-accent{color:#e8875a;margin-left:8px;text-shadow:0 0 24px rgba(232,135,90,.25)}',
      '.cr-start-sub{font-size:14px;line-height:1.5;color:#b8cbd4;letter-spacing:.02em}',
      '.cr-start-desc{max-width:540px;font-size:12.5px;line-height:1.65;color:#8fa8b5}',
      '.cr-start-actions{display:flex;flex-wrap:wrap;align-items:center;gap:9px;margin-top:8px}',
      '.cr-btn-lg{padding:12px 24px;font-size:15px;border-radius:10px}',
      '.cr-start-controls{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:6px;padding-top:12px;border-top:1px solid rgba(160,220,235,.1)}',
      '.cr-start-control{display:flex;align-items:center;gap:6px;font-size:11px;color:#8fa8b5}',
      '.cr-key{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 5px;border-radius:5px;border:1px solid rgba(160,220,235,.22);background:#0a1b26;color:#dce9ed;font-size:10px;font-weight:700}',
      '.cr-start-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}',
      '.cr-start-meta-item{display:flex;flex-direction:column;gap:2px;min-width:96px;padding:6px 10px;border-radius:8px;border:1px solid rgba(120,180,200,.16);background:rgba(8,22,32,.7)}',
      '.cr-start-meta-k{font-size:8px;letter-spacing:.16em;color:#8fa8b5;text-transform:uppercase}',
      '.cr-start-meta-v{font-size:13px;font-weight:800;color:#f2faf8;font-variant-numeric:tabular-nums}',
      '.cr-start-hint{font-size:10.5px;color:#6f8794}',
      '.cr-start-art{position:relative;min-height:360px;border:1px solid rgba(120,190,210,.24);border-radius:20px;overflow:hidden;background:radial-gradient(circle at 72% 64%,rgba(232,135,90,.16),transparent 34%),radial-gradient(circle at 28% 22%,rgba(103,232,214,.1),transparent 46%),linear-gradient(155deg,#0a1f2c,#06121b 72%);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 22px 54px rgba(0,0,0,.38)}',
      '.cr-start-art:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(103,232,214,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(103,232,214,.055) 1px,transparent 1px);background-size:22px 22px;mask-image:linear-gradient(180deg,transparent,#000 22%,#000 82%,transparent)}',
      '.cr-start-art:after{content:"";position:absolute;left:0;right:0;bottom:0;height:46%;background:linear-gradient(0deg,rgba(4,12,18,.9),transparent);pointer-events:none}',
      '.cr-art-top{position:absolute;top:14px;left:16px;right:16px;display:flex;justify-content:space-between;align-items:center;z-index:2;font-size:8.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}',
      '.cr-art-status{color:#67e8d6}',
      '.cr-art-best{color:#8fa8b5;font-variant-numeric:tabular-nums}',
      '.cr-art-floor{position:absolute;left:8%;right:8%;bottom:54px;height:1px;background:linear-gradient(90deg,transparent,rgba(103,232,214,.55),rgba(232,135,90,.35),transparent);z-index:1}',
      '.cr-art-dario{position:absolute;left:7%;bottom:62px;width:112px;aspect-ratio:51/56;background-repeat:no-repeat;background-size:1200% 100%;background-position:0 0;image-rendering:pixelated;filter:drop-shadow(0 8px 12px rgba(0,0,0,.45));z-index:2;animation:cr-dario-bob 1.35s ease-in-out infinite alternate}',
      '.cr-art-clawd{position:absolute;right:7%;bottom:56px;width:188px;aspect-ratio:46/36;background-repeat:no-repeat;background-size:1200% 100%;background-position:0 0;image-rendering:pixelated;filter:drop-shadow(0 12px 18px rgba(0,0,0,.5)) drop-shadow(0 0 16px rgba(232,135,90,.16));z-index:3;animation:cr-clawd-bob 1.8s ease-in-out infinite alternate}',
      '.cr-art-token{position:absolute;width:8px;height:8px;border-radius:1px;background:#67e8d6;box-shadow:0 0 10px rgba(103,232,214,.75);transform:rotate(45deg);z-index:2;animation:cr-token-float 2.2s ease-in-out infinite alternate}',
      '.cr-art-token.is-one{left:52%;top:32%;animation-delay:-.3s}',
      '.cr-art-token.is-two{left:66%;top:22%;width:6px;height:6px;animation-delay:-1.1s}',
      '.cr-art-token.is-three{left:46%;top:55%;width:5px;height:5px;animation-delay:-1.7s}',
      '.cr-art-caption{position:absolute;left:16px;right:16px;bottom:12px;display:flex;justify-content:space-between;align-items:flex-end;gap:10px;border-top:1px solid rgba(160,220,235,.12);padding-top:8px;z-index:2}',
      '.cr-art-caption-label{font-size:8px;letter-spacing:.18em;color:#67e8d6;font-weight:800}',
      '.cr-art-caption-sub{font-size:10.5px;color:#c9dbe2;text-align:right}',
      '@keyframes cr-clawd-bob{from{transform:translateY(0)}to{transform:translateY(-4px)}}',
      '@keyframes cr-dario-bob{from{transform:translateY(0)}to{transform:translateY(-2px)}}',
      '@keyframes cr-token-float{from{transform:rotate(45deg) translateY(0)}to{transform:rotate(45deg) translateY(-7px)}}',
      '@media (max-width:820px){.cr-start{padding:18px}.cr-start-inner{grid-template-columns:1fr;gap:16px}.cr-start-art{min-height:250px;order:-1}.cr-start-title{font-size:42px}}',
      '@media (max-width:600px){.cr-start-art{display:none}}',
      '.cr-toast{position:absolute;left:50%;top:22px;transform:translateX(-50%);padding:7px 14px;border-radius:999px;background:#08131f;border:1px solid rgba(120,230,210,.65);color:#eafffb;font-size:12.5px;font-weight:800;letter-spacing:.02em;white-space:nowrap;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.4);text-shadow:0 1px 2px rgba(0,0,0,.55);animation:cr-toast 1.2s ease-out forwards}',
      '@keyframes cr-toast{0%{opacity:0;transform:translate(-50%,6px)}14%{opacity:1;transform:translate(-50%,0)}78%{opacity:1}100%{opacity:0;transform:translate(-50%,-6px)}}',
      '.cr-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.cr-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-actions{display:flex;gap:7px;flex-wrap:wrap}',
      '.cr-btn{appearance:none;padding:7px 14px;border-radius:8px;font:inherit;font-size:12px;font-weight:650;line-height:1.2;cursor:pointer;color:#dce9ed;background:#0d2130;border:1px solid rgba(140,200,220,.22);transition:background 120ms ease,border-color 120ms ease,transform 80ms ease}',
      '.cr-btn:hover:not(:disabled){background:#133141;border-color:rgba(140,200,220,.42)}',
      '.cr-btn:active:not(:disabled){transform:translateY(1px)}',
      '.cr-btn:disabled{opacity:.42;cursor:default;transform:none}',
      '.cr-btn.is-on{border-color:rgba(103,232,214,.55);color:#8fe8da;background:#0c2630}',
      '.cr-btn.is-primary{background:linear-gradient(135deg,#f0a07a,#d97757);border-color:transparent;color:#1d0f0a;box-shadow:0 5px 16px rgba(217,119,87,.28)}',
      '.cr-btn.is-primary:hover:not(:disabled){background:linear-gradient(135deg,#f6ad8a,#e8875a)}',
      '.cr-btn:focus-visible,.cr-canvas:focus-visible{outline:2px solid #7fd0c0;outline-offset:2px}',
      '@media (max-width:600px){.cr-page{padding:12px 12px 16px}.cr-title{font-size:26px}.cr-stat{min-width:48px;padding:5px 6px}.cr-stat-v{font-size:13px;line-height:1.25}.cr-stat-k{font-size:8.5px}.cr-aquarium{padding:7px}.cr-overlay{inset:7px}.cr-hint{font-size:10.5px}}',
      '@media (prefers-reduced-motion:reduce){.cr-overlay,.cr-card,.cr-toast,.cr-art-clawd,.cr-art-dario,.cr-art-token{animation:none}}',
    ].join('\n')

    // ── 文案 ────────────────────────────────────────────────────────────────
    const ZH = {
      'nav.label': 'Clawd 快跑',
      'panel.subtitle': '从 Anthropic 跑路，捡 token 保命。',
      'stat.score': '得分',
      'stat.best': '最高',
      'stat.tokens': 'TOKEN',
      'stat.distance': '距离',
      'hud.chaser': '达里奥',
      'hud.sector': 'SECTOR {n} · {name}',
      'sector.server': '服务器区',
      'sector.cooling': '冷却区',
      'sector.core': '核心区',
      'toast.sector': '进入 {name}',
      'action.start': '开始',
      'action.pause': '暂停',
      'action.resume': '继续',
      'action.new': '新局',
      'action.again': '再来一局',
      'action.jump': '跳跃',
      'action.slide': '滑铲',
      'action.soundOn': '音效 开',
      'action.fullscreen': '全屏',
      'action.soundOff': '音效 关',
      'start.brand': 'Clawd',
      'start.accent': '快跑',
      'start.kicker': 'ANTHROPIC DATA CENTER // ESCAPE',
      'start.desc': '跳过倒下的服务器机箱，滑过安全激光门，捡 token 把达里奥甩在身后。',
      'start.cta': '开始快跑',
      'start.recordLabel': '历史记录',
      'start.currentSector': '当前区域',
      'start.sideNote': '每 300m 切换区域：服务器区 → 冷却区 → 核心区。',
      'start.jump': '跳跃',
      'start.slide': '滑铲',
      'start.pause': '暂停',
      'start.keySpace': '空格',
      'start.enterHint': '空格 / 回车也能开始',
      'overlay.paused.kicker': 'RUN PAUSED // 喘口气',
      'overlay.over.kicker': 'RUN ENDED // 被抓住了',
      'overlay.over.rankLabel': '本局评价',
      'overlay.over.tokens': '本局捡了 {tokens} 个 token',
      'overlay.over.rank.free': '自由之身',
      'overlay.over.rank.escape': '越狱者',
      'overlay.over.rank.intern': '熟练实习生',
      'overlay.over.rank.caught': '被抓实习生',
      'action.menu': '回到首页',
      'start.artStatus': 'SECURITY BREACH',
      'start.artCaption': 'ESCAPE // DATA CENTER',
      'overlay.ready.title': 'Clawd 快跑',
      'overlay.ready.note': '跳过安全路障、滑过审查横幅，捡 token 拉开和达里奥的距离。空格/↑ 跳，↓ 滑，P 暂停。',
      'overlay.paused.title': '暂停',
      'overlay.paused.note': '按空格 / Esc 或点「继续」，Clawd 先喘口气。',
      'overlay.over.title': '被达里奥抓住了',
      'overlay.over.note': '得分 {score} · 最高 {best}',
      'overlay.over.stats': '跑了 {distance}m · 捡了 {tokens} 个 token',
      'toast.hit': '差点被抓住！',
      'toast.milestone': '{distance}m！',
      'hint.keys': '空格 / ↑ 跳跃 · ↓ 滑铲 · P / Esc 暂停',
      'hint.touch': '点画面跳跃 · 点「滑铲」下蹲',
      'board.label': 'Clawd 快跑游戏画面',
      'chase.label': '达里奥',
    }
    const EN = {
      'nav.label': 'Clawd Run',
      'panel.subtitle': 'Escaping Anthropic, one token at a time.',
      'stat.score': 'Score',
      'stat.best': 'Best',
      'stat.tokens': 'Tokens',
      'stat.distance': 'Distance',
      'hud.chaser': 'Dario',
      'hud.sector': 'SECTOR {n} · {name}',
      'sector.server': 'Server Halls',
      'sector.cooling': 'Cooling Pipes',
      'sector.core': 'The Core',
      'toast.sector': 'Entering {name}',
      'action.start': 'Start',
      'action.pause': 'Pause',
      'action.resume': 'Resume',
      'action.new': 'New game',
      'action.again': 'Play again',
      'action.jump': 'Jump',
      'action.slide': 'Slide',
      'action.soundOn': 'Sound on',
      'action.fullscreen': 'Fullscreen',
      'action.soundOff': 'Sound off',
      'start.brand': 'Clawd',
      'start.accent': 'Run',
      'start.kicker': 'ANTHROPIC DATA CENTER // ESCAPE',
      'start.desc': 'Hop fallen server crates, slide under security lasers, and grab tokens to keep Dario off your tail.',
      'start.cta': 'Start running',
      'start.recordLabel': 'RUN RECORD',
      'start.currentSector': 'CURRENT SECTOR',
      'start.sideNote': 'New sector every 300m: server hall → cooling → core.',
      'start.jump': 'Jump',
      'start.slide': 'Slide',
      'start.pause': 'Pause',
      'start.keySpace': 'Space',
      'start.enterHint': 'Space / Enter also starts',
      'overlay.paused.kicker': 'RUN PAUSED // CATCH BREATH',
      'overlay.over.kicker': 'RUN ENDED // CAUGHT',
      'overlay.over.rankLabel': 'RUN RATING',
      'overlay.over.tokens': 'Grabbed {tokens} tokens this run',
      'overlay.over.rank.free': 'FREE AT LAST',
      'overlay.over.rank.escape': 'ESCAPEE',
      'overlay.over.rank.intern': 'SEASONED INTERN',
      'overlay.over.rank.caught': 'CAUGHT INTERN',
      'action.menu': 'Home',
      'start.artStatus': 'SECURITY BREACH',
      'start.artCaption': 'ESCAPE // DATA CENTER',
      'overlay.ready.title': 'Clawd Run',
      'overlay.ready.note': 'Hop the safety rails, slide under review banners, and grab tokens to keep Dario off your tail. Space/Up to jump, Down to slide, P to pause.',
      'overlay.paused.title': 'Paused',
      'overlay.paused.note': 'Press Space / Esc or Resume — Clawd can catch a breath.',
      'overlay.over.title': 'Dario caught you',
      'overlay.over.note': 'Score {score} · best {best}',
      'overlay.over.stats': 'Ran {distance}m · grabbed {tokens} tokens',
      'toast.hit': 'Almost caught!',
      'toast.milestone': '{distance}m!',
      'hint.keys': 'Space / Up to jump · Down to slide · P / Esc to pause',
      'hint.touch': 'Tap to jump · tap Slide to duck',
      'board.label': 'Clawd Run game screen',
      'chase.label': 'Dario',
    }

    let translate = (key) => ZH[key] || key
    const localeListeners = new Set()
    function t(key) { return translate(key) }
    function fmt(key, vars) {
      let text = t(key)
      for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]))
      return text
    }
    function useLocaleVersion() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((n) => n + 1)
        localeListeners.add(listener)
        return () => { localeListeners.delete(listener) }
      }, [])
    }

    // ── 面板 ────────────────────────────────────────────────────────────────
    function PanelClawdRun(props) {
      useLocaleVersion()

      const bootRef = useRef(null)
      if (!bootRef.current) bootRef.current = loadGameState()
      const boot = bootRef.current

      const [game, setGame] = useState(boot.game)
      const [best, setBest] = useState(boot.best)
      const [soundOn, setSoundOn] = useState(boot.soundOn)
      const [toast, setToast] = useState(null)

      const pageRef = useRef(null)
      const gameRef = useRef(boot.game)
      const bestRef = useRef(boot.best)
      const soundRef = useRef(boot.soundOn)
      const scaleRef = useRef(6)
      const canvasRef = useRef(null)
      const screenRef = useRef(null)
      const jumpPressedRef = useRef(false)
      const slidePressedRef = useRef(false)
      const hudRef = useRef('')
      const toastTimerRef = useRef(null)
      const mountedRef = useRef(true)

      const commit = useCallback((next) => {
        gameRef.current = next
        setGame(next)
        persistGame(next)
        return next
      }, [])

      const finishRun = useCallback((next) => {
        if (!next || next.status !== 'over') return
        if (next.score > bestRef.current) {
          bestRef.current = next.score
          setBest(next.score)
          saveBest(next.score)
        }
        persistGame(next)
        if (soundRef.current) playSfx('caught')
      }, [])

      const newGameNow = useCallback(() => {
        const next = { ...createGame({ seed: randomSeed() }), status: 'running' }
        jumpPressedRef.current = false
        slidePressedRef.current = false
        commit(next)
        if (soundRef.current) playSfx('start')
      }, [commit])

      const backToMenu = useCallback(() => {
        const next = createGame({ seed: randomSeed() })
        jumpPressedRef.current = false
        slidePressedRef.current = false
        commit(next)
      }, [commit])

      const primary = useCallback(() => {
        const current = gameRef.current
        if (current.status === 'ready' || current.status === 'paused') {
          commit({ ...current, status: 'running' })
          if (soundRef.current) playSfx('start')
          return
        }
        if (current.status === 'running') {
          jumpPressedRef.current = false
          slidePressedRef.current = false
          commit({ ...current, status: 'paused' })
          if (soundRef.current) playSfx('pause')
          return
        }
        newGameNow()
      }, [commit, newGameNow])

      const toggleSound = useCallback(() => {
        const next = !soundRef.current
        soundRef.current = next
        setSoundOn(next)
        saveSoundOn(next)
        if (next) playSfx('pause')
      }, [])

      const toggleFullscreen = useCallback(() => {
        const el = pageRef.current
        if (!el) return
        try {
          if (document.fullscreenElement) {
            if (document.exitFullscreen) document.exitFullscreen()
          } else if (el.requestFullscreen) {
            el.requestFullscreen().catch(() => {})
          }
        } catch (error) { /* 全屏不可用就保持原样 */ }
      }, [])

      const showToast = useCallback((text) => {
        setToast({ text, ts: Date.now() })
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => {
          if (mountedRef.current) setToast(null)
        }, 1250)
      }, [])

      const jumpNow = useCallback(() => {
        if (gameRef.current.status === 'running') jumpPressedRef.current = true
        else primary()
      }, [primary])

      const slideNow = useCallback(() => {
        if (gameRef.current.status === 'running') slidePressedRef.current = true
      }, [])

      // 画布整数倍缩放
      useEffect(() => {
        const el = screenRef.current
        if (!el) return undefined
        const measure = () => {
          const dpr = window.devicePixelRatio || 1
          const byWidth = (Math.max(VIEW_W, el.clientWidth) * dpr) / VIEW_W
          const heightLimit = Math.max(VIEW_H, window.innerHeight - 200)
          const byHeight = (heightLimit * dpr) / VIEW_H
          scaleRef.current = Math.max(2, Math.min(12, Math.floor(Math.min(byWidth, byHeight))))
        }
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(measure)
          observer.observe(el)
          return () => observer.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [])

      // 主循环
      useEffect(() => {
        mountedRef.current = true
        const canvas = canvasRef.current
        if (!canvas) return undefined
        let ctx = null
        try { ctx = canvas.getContext('2d') } catch (error) { ctx = null }
        if (!ctx) return undefined
        let raf = 0
        let last = performance.now()
        let lastCssW = 0
        const input = () => {
          const jump = jumpPressedRef.current
          const slide = slidePressedRef.current
          jumpPressedRef.current = false
          slidePressedRef.current = false
          return { jump, slide }
        }
        const syncHud = (next) => {
          const key = next.status + '|' + next.score + '|' + next.tokens + '|' + Math.floor(next.distance) + '|' + Math.round(next.gap / 2)
          if (key !== hudRef.current) {
            hudRef.current = key
            setGame(next)
          }
        }
        const frame = (now) => {
          raf = requestAnimationFrame(frame)
          const dpr = window.devicePixelRatio || 1
          const scale = scaleRef.current
          if (canvas.width !== VIEW_W * scale || canvas.height !== VIEW_H * scale) {
            canvas.width = VIEW_W * scale
            canvas.height = VIEW_H * scale
          }
          const cssW = (VIEW_W * scale) / dpr
          const cssH = (VIEW_H * scale) / dpr
          if (cssW !== lastCssW) {
            lastCssW = cssW
            canvas.style.width = cssW + 'px'
            canvas.style.height = cssH + 'px'
          }
          ctx.setTransform(scale, 0, 0, scale, 0, 0)
          const dt = Math.max(0, Math.min(0.05, (now - last) / 1000))
          last = now
          let current = gameRef.current
          if (current.status === 'running') {
            const result = stepGame(current, dt, input())
            if (result.game !== current) {
              current = result.game
              gameRef.current = current
              for (const event of result.events) {
                if (event === 'jump') {
                  if (soundRef.current) playSfx('jump')
                } else if (event === 'slide') {
                  if (soundRef.current) playSfx('slide')
                } else if (event === 'token') {
                  if (soundRef.current) playSfx('token')
                } else if (event === 'hit') {
                  if (soundRef.current) playSfx('hit')
                  showToast(t('toast.hit'))
                } else if (event === 'milestone') {
                  if (soundRef.current) playSfx('milestone')
                  showToast(fmt('toast.milestone', { distance: Math.floor(current.distance / MILESTONE) * MILESTONE }))
                } else if (event === 'sector') {
                  if (soundRef.current) playSfx('milestone')
                  const sectorIndex = (sectorOf(current.distance) - 1) % 3
                  const sectorNames = ['sector.server', 'sector.cooling', 'sector.core']
                  showToast(fmt('toast.sector', { name: t(sectorNames[sectorIndex]) }))
                } else if (event === 'caught') {
                  finishRun(current)
                }
              }
              syncHud(current)
            }
          }
          drawFrame(ctx, current, now)
        }
        raf = requestAnimationFrame(frame)
        return () => {
          mountedRef.current = false
          cancelAnimationFrame(raf)
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
          const current = gameRef.current
          if (current.status === 'running') {
            const paused = { ...current, status: 'paused' }
            gameRef.current = paused
            persistGame(paused)
          } else {
            persistGame(current)
          }
        }
      }, [finishRun, showToast])

      useEffect(() => {
        const onVisibility = () => {
          if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return
          const current = gameRef.current
          if (current.status === 'running') {
            const paused = { ...current, status: 'paused' }
            gameRef.current = paused
            setGame(paused)
            persistGame(paused)
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
          const key = event.key
          const status = gameRef.current.status
          if (key === ' ' || key === 'Spacebar' || key === 'ArrowUp' || key === 'w' || key === 'W') {
            event.preventDefault()
            if (status === 'running') jumpNow()
            else primary()
            return
          }
          if (key === 'Enter') {
            event.preventDefault()
            if (status !== 'running') primary()
            return
          }
          if (key === 'ArrowDown' || key === 's' || key === 'S') {
            event.preventDefault()
            if (status === 'running') slideNow()
            return
          }
          if (key === 'p' || key === 'P' || key === 'Escape') {
            event.preventDefault()
            if (status === 'running' || status === 'paused') primary()
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [jumpNow, primary, slideNow])

      const pointerJump = () => {
        if (gameRef.current.status === 'running') jumpNow()
        else primary()
      }

      const liveBest = Math.max(best, game.score)
      const distance = Math.floor(game.distance)
      const sector = sectorOf(game.distance)
      const sectorName = t(['sector.server', 'sector.cooling', 'sector.core'][(sector - 1) % 3])
      const sectorLabel = fmt('hud.sector', { n: String(sector).padStart(2, '0'), name: sectorName })
      const gapPct = clamp(Math.round((game.gap / MAX_GAP) * 100), 0, 100)
      const chaseClass = gapPct < 22 ? ' is-danger' : gapPct < 45 ? ' is-warn' : ''
      const primaryLabel = game.status === 'running'
        ? t('action.pause')
        : game.status === 'paused'
          ? t('action.resume')
          : game.status === 'over'
            ? t('action.again')
            : t('action.start')

      const overlay = (() => {
        if (game.status === 'ready') {
          const control = (label, keys) => h('div', { className: 'cr-start-control' },
            keys.map((key) => h('span', { className: 'cr-key', key }, key)),
            h('span', null, label),
          )
          return h('div', { className: 'cr-overlay cr-overlay-start' },
            h('div', { className: 'cr-start' },
              h('div', { className: 'cr-start-inner' },
                h('div', { className: 'cr-start-main' },
                  h('div', { className: 'cr-start-kicker' },
                    h('span', { className: 'cr-start-dot' }),
                    t('start.kicker')),
                  h('h1', { className: 'cr-start-title' },
                    t('start.brand'),
                    h('span', { className: 'cr-title-accent' }, t('start.accent'))),
                  h('div', { className: 'cr-start-sub' }, t('panel.subtitle')),
                  h('div', { className: 'cr-start-desc' }, t('start.desc')),
                  h('div', { className: 'cr-start-actions' },
                    h('button', { type: 'button', className: 'cr-btn is-primary cr-btn-lg', onClick: primary }, t('start.cta')),
                    h('button', { type: 'button', className: 'cr-btn' + (soundOn ? ' is-on' : ''), onClick: toggleSound, 'aria-pressed': soundOn ? 'true' : 'false' }, soundOn ? t('action.soundOn') : t('action.soundOff')),
                    h('button', { type: 'button', className: 'cr-btn', onClick: toggleFullscreen }, t('action.fullscreen')),
                  ),
                  h('div', { className: 'cr-start-controls' },
                    control(t('start.jump'), [t('start.keySpace'), '↑']),
                    control(t('start.slide'), ['↓']),
                    control(t('start.pause'), ['P', 'Esc']),
                  ),
                  h('div', { className: 'cr-start-meta' },
                    h('div', { className: 'cr-start-meta-item' },
                      h('span', { className: 'cr-start-meta-k' }, t('start.recordLabel')),
                      h('span', { className: 'cr-start-meta-v' }, String(liveBest))),
                    h('div', { className: 'cr-start-meta-item' },
                      h('span', { className: 'cr-start-meta-k' }, t('start.currentSector')),
                      h('span', { className: 'cr-start-meta-v' }, sectorLabel)),
                  ),
                  h('div', { className: 'cr-start-hint' }, t('start.enterHint')),
                ),
                h('div', { className: 'cr-start-art' },
                  h('div', { className: 'cr-art-top' },
                    h('span', { className: 'cr-art-status' }, t('start.artStatus'))),
                  h('span', { className: 'cr-art-token is-one' }),
                  h('span', { className: 'cr-art-token is-two' }),
                  h('span', { className: 'cr-art-token is-three' }),
                  h('div', { className: 'cr-art-floor' }),
                  h('div', { className: 'cr-art-dario', style: { backgroundImage: 'url(' + DARIO_SHEET + ')' } }),
                  h('div', { className: 'cr-art-clawd', style: { backgroundImage: 'url(' + CLAWD_RUN_SHEET + ')' } }),
                  h('div', { className: 'cr-art-caption' },
                    h('span', { className: 'cr-art-caption-label' }, t('start.artCaption')),
                    h('span', { className: 'cr-art-caption-sub' }, sectorLabel)),
                ),
              ),
            ),
          )
        }
        if (game.status === 'paused') {
          return h('div', { className: 'cr-overlay' },
            h('div', { className: 'cr-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('overlay.paused.title') },
              h('div', { className: 'cr-card-kicker' }, t('overlay.paused.kicker')),
              h('div', { className: 'cr-card-title' }, t('overlay.paused.title')),
              h('div', { className: 'cr-card-note' }, t('overlay.paused.note')),
              h('div', { className: 'cr-card-stats' },
                h('div', { className: 'cr-card-stat' }, h('div', { className: 'cr-card-stat-k' }, t('stat.score')), h('div', { className: 'cr-card-stat-v' }, String(game.score))),
                h('div', { className: 'cr-card-stat' }, h('div', { className: 'cr-card-stat-k' }, t('stat.distance')), h('div', { className: 'cr-card-stat-v' }, distance + 'm')),
                h('div', { className: 'cr-card-stat' }, h('div', { className: 'cr-card-stat-k' }, t('stat.best')), h('div', { className: 'cr-card-stat-v' }, String(liveBest))),
              ),
              h('div', { className: 'cr-card-actions' },
                h('button', { type: 'button', className: 'cr-btn is-primary', onClick: primary }, t('action.resume')),
                h('button', { type: 'button', className: 'cr-btn', onClick: newGameNow }, t('action.new')),
                h('button', { type: 'button', className: 'cr-btn', onClick: backToMenu }, t('action.menu')),
              ),
            ),
          )
        }
        if (game.status === 'over') {
          const rankKey = distance >= 500 ? 'free' : distance >= 300 ? 'escape' : distance >= 150 ? 'intern' : 'caught'
          return h('div', { className: 'cr-overlay' },
            h('div', { className: 'cr-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('overlay.over.title') },
              h('div', { className: 'cr-card-kicker' }, t('overlay.over.kicker')),
              h('div', { className: 'cr-card-title' }, t('overlay.over.title')),
              h('div', { className: 'cr-card-rank' }, t('overlay.over.rank.' + rankKey)),
              h('div', { className: 'cr-card-stats' },
                h('div', { className: 'cr-card-stat' }, h('div', { className: 'cr-card-stat-k' }, t('stat.score')), h('div', { className: 'cr-card-stat-v' }, String(game.score))),
                h('div', { className: 'cr-card-stat' }, h('div', { className: 'cr-card-stat-k' }, t('stat.best')), h('div', { className: 'cr-card-stat-v' }, String(liveBest))),
                h('div', { className: 'cr-card-stat' }, h('div', { className: 'cr-card-stat-k' }, t('stat.distance')), h('div', { className: 'cr-card-stat-v' }, distance + 'm')),
              ),
              h('div', { className: 'cr-card-note' }, fmt('overlay.over.tokens', { tokens: game.tokens })),
              h('div', { className: 'cr-card-actions' },
                h('button', { type: 'button', className: 'cr-btn is-primary', onClick: newGameNow }, t('action.again')),
                h('button', { type: 'button', className: 'cr-btn', onClick: backToMenu }, t('action.menu')),
              ),
            ),
          )
        }
        return null
      })()

      const stat = (label, value, className) => h(
        'div',
        { className: 'cr-stat' + (className ? ' ' + className : '') },
        h('div', { className: 'cr-stat-k' }, label),
        h('div', { className: 'cr-stat-v' }, String(value)),
      )

      return h(
        'div',
        { className: 'cr-page', ref: pageRef },
        h('style', null, CSS),
        h(
          'div',
          { className: 'cr-shell' },
          game.status === 'ready' ? null : h(
            'div',
            { className: 'cr-head' },
            h(
              'div',
              { className: 'cr-brand' },
              h(
                'div',
                { className: 'cr-wordmark' },
                h('span', { className: 'cr-logo' }, h(LogoClawd, { size: 26 })),
                h('span', { className: 'cr-title' }, t('nav.label')),
              ),
              h('div', { className: 'cr-sub' },
                t('panel.subtitle'),
                h('span', { className: 'cr-sector' }, sectorLabel)),
            ),
            game.status === 'ready' ? null : h(
              'div',
              { className: 'cr-stats' },
              stat(t('stat.score'), game.score),
              stat(t('stat.best'), liveBest, 'is-best'),
              stat(t('stat.tokens'), game.tokens, 'is-token'),
              stat(t('stat.distance'), distance + 'm'),
            ),
          ),
          game.status === 'ready' ? null : h(
            'div',
            { className: 'cr-chase' + chaseClass },
            h('span', { className: 'cr-chase-label' }, t('hud.chaser')),
            h('div', { className: 'cr-chase-track' }, h('div', { className: 'cr-chase-fill', style: { width: gapPct + '%' } })),
            h('span', { className: 'cr-chase-pct' }, gapPct + '%'),
          ),
          h(
            'div',
            { className: 'cr-aquarium' },
            h(
              'div',
              { className: 'cr-screen-slot', ref: screenRef },
              h('canvas', {
                ref: canvasRef,
                className: 'cr-canvas',
                width: VIEW_W * 6,
                height: VIEW_H * 6,
                role: 'img',
                'aria-label': t('board.label'),
                onPointerDown: pointerJump,
              }),
            ),
            overlay,
            toast ? h('div', { className: 'cr-toast', key: toast.ts }, toast.text) : null,
          ),
          game.status === 'ready' ? null : h(
            'div',
            { className: 'cr-foot' },
            h('div', { className: 'cr-hint' },
              t('hint.keys'),
              h('br'),
              t('hint.touch')),
            h(
              'div',
              { className: 'cr-actions' },
              h('button', { type: 'button', className: 'cr-btn', onClick: primary }, primaryLabel),
              h('button', {
                type: 'button',
                className: 'cr-btn',
                onClick: jumpNow,
                disabled: game.status !== 'running',
              }, t('action.jump')),
              h('button', {
                type: 'button',
                className: 'cr-btn',
                onClick: slideNow,
                disabled: game.status !== 'running',
              }, t('action.slide')),
              h('button', {
                type: 'button',
                className: 'cr-btn' + (soundOn ? ' is-on' : ''),
                onClick: toggleSound,
                'aria-pressed': soundOn ? 'true' : 'false',
              }, soundOn ? t('action.soundOn') : t('action.soundOff')),
              h('button', { type: 'button', className: 'cr-btn', onClick: toggleFullscreen }, t('action.fullscreen')),
              h('button', { type: 'button', className: 'cr-btn is-primary', onClick: newGameNow }, t('action.new')),
            ),
          ),
        ),
      )
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          const pairs = [['zh', ZH], ['zh-CN', ZH], ['en', EN], ['en-US', EN]]
          for (const [locale, dict] of pairs) {
            try {
              disposers.push(ctx.locale.register(NS, locale, dict))
            } catch (error) {
              // 语言标签不被接受时跳过，中文兜底仍在
            }
          }
          try {
            const bound = ctx.locale.bind(NS)
            translate = (key) => bound(key)
          } catch (error) {
            translate = (key) => ZH[key] || key
          }
          const off = ctx.locale.subscribe(() => {
            for (const listener of Array.from(localeListeners)) {
              try { listener() } catch (error) { /* 单个订阅者失败不影响其他渲染 */ }
            }
          })
          return () => {
            try { off() } catch (error) { /* 已释放 */ }
            for (const dispose of disposers) {
              try { dispose() } catch (error) { /* 已释放 */ }
            }
          }
        }, 'dsh-clawd-run: locale dictionaries')

        // 入口：装了游戏厅就向游戏厅登记；没装就回退独立图标 + 主面板。
        ctx.effect(() => {
          const disposeSlots = []
          let disposeArcade = null
          let poll = null
          let settle = null
          const detachSlots = () => {
            while (disposeSlots.length) {
              try { disposeSlots.pop()() } catch (error) { /* 已释放 */ }
            }
          }
          const attachArcade = (arcade) => {
            if (disposeArcade) return
            disposeArcade = arcade.register({
              id: PANEL_ID,
              order: 51,
              title: () => t('nav.label'),
              icon: IconClawd,
              Panel: PanelClawdRun,
            })
            detachSlots()
          }
          const arcade = typeof window !== 'undefined' ? window.__dshArcade : null
          if (arcade && typeof arcade.register === 'function') {
            attachArcade(arcade)
            return () => {
              if (disposeArcade) { try { disposeArcade() } catch (error) { /* 已释放 */ } }
            }
          }
          disposeSlots.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 51, label: () => t('nav.label') },
            IconClawd,
          )))
          disposeSlots.push(ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: PANEL_ID },
            PanelClawdRun,
          )))
          const tryAttachArcade = () => {
            const found = typeof window !== 'undefined' ? window.__dshArcade : null
            if (!found || typeof found.register !== 'function') return
            if (poll) { clearInterval(poll); poll = null }
            attachArcade(found)
          }
          let arcadeReadyListener = null
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            arcadeReadyListener = tryAttachArcade
            window.addEventListener('dsh-arcade-ready', arcadeReadyListener)
          }
          poll = setInterval(tryAttachArcade, 120)
          settle = setTimeout(() => {
            if (poll) { clearInterval(poll); poll = null }
          }, 5000)
          return () => {
            if (poll) clearInterval(poll)
            if (settle) clearTimeout(settle)
            if (arcadeReadyListener) {
              try { window.removeEventListener('dsh-arcade-ready', arcadeReadyListener) } catch (error) { /* 已释放 */ }
            }
            if (disposeArcade) { try { disposeArcade() } catch (error) { /* 已释放 */ } }
            detachSlots()
          }
        }, 'dsh-clawd-run: panel entry')
      },
    }
  },
})
