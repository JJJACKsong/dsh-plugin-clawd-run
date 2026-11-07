/**
 * dsh-plugin-clawd-run — Clawd 逃亡（浏览器半，手写 bundle，无构建步骤）。
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
    const MILESTONE = 250
    const SECTOR_LENGTH = 300
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

    /**
     * 关卡图案：一次生成 1~3 个障碍，按动作时间留出可完成间距。
     * tier 随距离上升：单障碍 → 低高组合 → 三连交替。
     */
    function createObstaclePattern(rngState, distance, speed) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      const tier = distance < 150 ? 0 : distance < 400 ? 1 : distance < 800 ? 2 : 3
      const roll = rand()
      let kinds
      if (tier === 0) {
        kinds = roll < 0.55 ? ['low'] : ['high']
      } else if (tier === 1) {
        kinds = roll < 0.32 ? ['low'] : roll < 0.64 ? ['high'] : roll < 0.84 ? ['low', 'high'] : ['high', 'low']
      } else if (tier === 2) {
        kinds = roll < 0.22 ? ['low'] : roll < 0.44 ? ['high'] : roll < 0.68 ? ['low', 'high'] : roll < 0.86 ? ['high', 'low'] : ['low', 'high', 'low']
      } else {
        kinds = roll < 0.18 ? ['high'] : roll < 0.38 ? ['low', 'high'] : roll < 0.58 ? ['high', 'low'] : roll < 0.8 ? ['low', 'high', 'low'] : ['high', 'low', 'high']
      }
      const gapTime = 0.82 + rand() * 0.22
      const gapPx = Math.round(speed * gapTime)
      const obstacles = []
      let x = VIEW_W + 40
      for (const kind of kinds) {
        obstacles.push({ type: kind, x })
        x += gapPx
      }
      return { obstacles, gapTime, endOffset: gapPx * (kinds.length - 1), rngState: state }
    }

    /** 生成一组 token 队形：wave / 阶梯 / zigzag / 双排 / 菱形簇。 */
    function createTokenPattern(rngState, nextId, startX, kind) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      let id = nextId
      const tokens = []
      const kinds = ['wave', 'stairUp', 'stairDown', 'zigzag', 'rows', 'cluster']
      const choice = kind || kinds[Math.floor(rand() * kinds.length)]
      const push = (x, y) => {
        tokens.push({ id: id++, x, y, phase: rand() * Math.PI * 2 })
      }
      if (choice === 'wave') {
        for (let i = 0; i < 7; i += 1) push(startX + i * 18, GROUND_Y - 32 + Math.sin(i * 0.9) * 14)
      } else if (choice === 'stairUp') {
        for (let i = 0; i < 5; i += 1) push(startX + i * 20, GROUND_Y - 18 - i * 9)
      } else if (choice === 'stairDown') {
        for (let i = 0; i < 5; i += 1) push(startX + i * 20, GROUND_Y - 54 + i * 9)
      } else if (choice === 'zigzag') {
        for (let i = 0; i < 6; i += 1) push(startX + i * 18, i % 2 === 0 ? GROUND_Y - 24 : GROUND_Y - 48)
      } else if (choice === 'rows') {
        for (let i = 0; i < 4; i += 1) {
          push(startX + i * 20, GROUND_Y - 28)
          push(startX + i * 20, GROUND_Y - 48)
        }
      } else {
        const cx = startX + 24
        const offsets = [[0, -34], [-10, -44], [10, -44], [0, -54], [0, -64]]
        for (const [dx, dy] of offsets) push(cx + dx, GROUND_Y + dy)
      }
      return { tokens, rngState: state, nextId: id }
    }

    /** 障碍配套 token：低障碍在上方摆弧线（要跳），高横幅在下方摆低线（要滑）。 */
    function createObstacleTokens(rngState, nextId, obstacle) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      let id = nextId
      const tokens = []
      if (obstacle.type === 'low') {
        const heights = [-26, -42, -56, -42, -26]
        for (let i = 0; i < heights.length; i += 1) {
          tokens.push({ id: id++, x: obstacle.x - 20 + i * 13, y: GROUND_Y + heights[i], phase: rand() * Math.PI * 2 })
        }
      } else {
        for (let i = 0; i < 4; i += 1) {
          tokens.push({ id: id++, x: obstacle.x - 8 + i * 12, y: GROUND_Y - 14, phase: rand() * Math.PI * 2 })
        }
      }
      return { tokens, rngState: state, nextId: id }
    }

    function createGame(options) {
      const opts = options || {}
      let rngState = Number.isFinite(opts.seed) ? (opts.seed >>> 0) : randomSeed()
      let nextId = 1
      const player = { y: 0, vy: 0, sliding: false, slideTimer: 0, invuln: 0, anim: 0 }
      const tokensList = []
      for (const startX of [270, 360]) {
        const created = createTokenPattern(rngState, nextId, startX)
        rngState = created.rngState
        nextId = created.nextId
        for (const token of created.tokens) tokensList.push(token)
      }
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
        tokenTimer: 0.7,
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
          const obstacle = { id: next.nextId, type: template.type, x: template.x }
          next.nextId += 1
          next.obstacles.push(obstacle)
          const formation = createObstacleTokens(rngState, next.nextId, obstacle)
          rngState = formation.rngState
          next.nextId = formation.nextId
          for (const token of formation.tokens) next.tokensList.push(token)
        }
        next.spawnTimer = pattern.endOffset / next.speed + 0.9 + rand() * 0.4
      }
      // token 串
      next.tokenTimer = game.tokenTimer - step
      if (next.tokenTimer <= 0) {
        const created = createTokenPattern(rngState, next.nextId, VIEW_W + 30)
        rngState = created.rngState
        next.nextId = created.nextId
        for (const token of created.tokens) next.tokensList.push(token)
        next.tokenTimer = 1.3 + rand() * 0.6
      }

      const dx = speed * step
      for (const obstacle of next.obstacles) obstacle.x -= dx
      for (const token of next.tokensList) {
        token.x -= dx
        token.phase += step * 2.2
      }
      next.obstacles = next.obstacles.filter((obstacle) => obstacle.x > -70)
      next.tokensList = next.tokensList.filter((token) => token.x > -30)
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
        spawnTimer: clamp(Number(game.spawnTimer) || 0, 0, 2),
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
          x: clamp(Number(item.x) || 0, -80, VIEW_W + 120),
        })),
        tokensList: tokensList.slice(0, 80).map((item) => ({
          id: Math.max(1, Math.floor(Number(item.id) || 1)),
          x: clamp(Number(item.x) || 0, -60, VIEW_W + 120),
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
          x: clamp(Number(item.x) || 0, -80, VIEW_W + 120),
        })
      }
      const tokensList = []
      for (const item of Array.isArray(raw.tokensList) ? raw.tokensList : []) {
        if (!item || !isFiniteNumber(item.x) || !isFiniteNumber(item.y)) continue
        tokensList.push({
          id: Math.max(1, Math.floor(Number(item.id) || tokensList.length + 1)),
          x: clamp(Number(item.x) || 0, -60, VIEW_W + 120),
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
        spawnTimer: clamp(Number(raw.spawnTimer) || 0.8, 0, 2),
        tokenTimer: clamp(Number(raw.tokenTimer) || 0.5, 0, 2),
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
          h('rect', { x: 8, y: 3, width: 1, height: 4 }),
          h('rect', { x: 15, y: 3, width: 1, height: 4, opacity: 0.7 }),
        ),
        h('g', { fill: 'currentColor', opacity: 0.9 },
          h('rect', { x: 7, y: 3, width: 2, height: 1 }),
          h('rect', { x: 14, y: 3, width: 2, height: 1 }),
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
          h('rect', { x: 12, y: 7, width: 1, height: 4 }),
          h('rect', { x: 19, y: 7, width: 1, height: 4 }),
        ),
        h('g', { fill: '#f4f0e8' },
          h('rect', { x: 10, y: 5, width: 3, height: 2 }),
          h('rect', { x: 18, y: 5, width: 3, height: 2 }),
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
    const TOKEN = { main: '#67e8d6', hi: '#d9fff8', dark: '#2f9f92' }
    const CRATE = { main: '#6b8ba1', hi: '#a8c6d8', dark: '#2a3f4f', stripe: '#ffcc4d' }
    const LASER = { beam: '#ff4d4d', glow: 'rgba(255,77,77,.28)', post: '#5a8098', postHi: '#a8c6d8' }
    const CLAWD = { body: '#e8875a', dark: '#b85f3a', belly: '#f6d3b3', eye: '#141414' }
    const DARIO = { suit: '#2b2f3a', suitHi: '#3a4050', shirt: '#d9d4c7', tie: '#b33a3a', skin: '#d9a77c', hair: '#2a2220', glasses: '#111820' }
    // 用户提供的 Running-Dario.gif，已拆成 12 帧精灵表内嵌（透明底）。
    const DARIO_SHEET = 'data:image/png;base64,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'
    const DARIO_FRAME_W = 51
    const DARIO_FRAME_H = 56
    const DARIO_FRAMES = 12
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
      const glow = 0.10 + Math.abs(Math.sin(now / 900 + x)) * 0.08
      ctx.globalAlpha = glow
      ctx.fillStyle = LED_GREEN
      ctx.fillRect(x - 3, y - 3, 32, 16)
      ctx.globalAlpha = 1
      ctx.fillStyle = '#0c3b2c'
      ctx.fillRect(x, y, 26, 10)
      ctx.fillStyle = LED_GREEN
      ctx.fillRect(x + 6, y + 4, 9, 2)
      ctx.fillRect(x + 13, y + 2, 2, 2)
      ctx.fillRect(x + 13, y + 6, 2, 2)
      ctx.fillRect(x + 2, y + 2, 2, 6)
    }

    function drawSectorBack(ctx, sector, worldX, now) {
      if (sector === 0) {
        // 服务器机架区
        const offset = -((worldX * 0.22) % 150)
        for (let i = 0; i < 4; i += 1) {
          const x = offset + i * 150
          drawRack(ctx, Math.round(x), 52, 96, GROUND_Y - 52, i + 1, now)
        }
        const glassOffset = -((worldX * 0.2) % 360)
        for (let i = 0; i < 3; i += 1) {
          const x = Math.round(glassOffset + i * 360 + 180)
          ctx.fillStyle = 'rgba(103,232,214,.05)'
          ctx.fillRect(x, 36, 46, 60)
          ctx.fillStyle = 'rgba(103,232,214,.18)'
          ctx.fillRect(x, 36, 46, 1)
          ctx.fillRect(x, 36, 1, 60)
        }
      } else if (sector === 1) {
        // 冷却管道区
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(0, 58, VIEW_W, 18)
        ctx.fillStyle = METAL
        ctx.fillRect(0, 58, VIEW_W, 2)
        ctx.fillRect(0, 73, VIEW_W, 2)
        const pipeOffset = -((worldX * 0.25) % 140)
        for (let i = 0; i < 4; i += 1) {
          const x = Math.round(pipeOffset + i * 140)
          ctx.fillStyle = METAL_HI
          ctx.fillRect(x, 55, 12, 24)
          ctx.fillStyle = METAL_DARK
          ctx.fillRect(x + 2, 59, 8, 16)
          ctx.fillRect(x + 3, 62, 6, 1)
          ctx.fillRect(x + 3, 68, 6, 1)
        }
        const fanOffset = -((worldX * 0.3) % 180)
        for (let i = 0; i < 3; i += 1) drawFan(ctx, Math.round(fanOffset + i * 180 + 60), 96, 16, now, i + 1)
        ctx.globalAlpha = 0.07
        ctx.fillStyle = LED_BLUE
        ctx.fillRect(0, GROUND_Y - 26, VIEW_W, 26)
        ctx.globalAlpha = 1
      } else {
        // 核心区
        const coreOffset = -((worldX * 0.22) % 180)
        for (let i = 0; i < 3; i += 1) {
          const x = Math.round(coreOffset + i * 180 + 30)
          ctx.fillStyle = METAL_DARK
          ctx.fillRect(x - 4, 40, 52, GROUND_Y - 40)
          ctx.fillStyle = '#0a1622'
          ctx.fillRect(x, 44, 44, GROUND_Y - 44)
          ctx.fillStyle = CYAN_DIM
          ctx.fillRect(x + 18, 48, 8, GROUND_Y - 52)
          ctx.fillStyle = CYAN
          ctx.fillRect(x + 20, 52, 4, GROUND_Y - 60)
          for (let ring = 0; ring < 4; ring += 1) {
            const ry = 60 + ring * 28
            ctx.fillStyle = METAL
            ctx.fillRect(x - 2, ry, 48, 2)
            ctx.fillStyle = 'rgba(103,232,214,.2)'
            ctx.fillRect(x - 2, ry + 2, 48, 1)
          }
          const spark = (Math.floor(now / 120) + i) % 9
          if (spark < 3) {
            ctx.fillStyle = WHITE_LIGHT
            ctx.fillRect(x + 26, 74 + spark * 18, 2, 4)
          }
          ctx.fillStyle = LED_RED
          ctx.fillRect(x + 4, 46, 2, 2)
        }
      }
      // EXIT 安全出口标志
      const signOffset = -((worldX * 0.4) % 360)
      for (let i = 0; i < 3; i += 1) {
        drawExitSign(ctx, Math.round(signOffset + i * 360 + 120), 48, now)
      }
    }

    function drawCeiling(ctx, worldX, now) {
      ctx.fillStyle = CEIL
      ctx.fillRect(0, 0, VIEW_W, 30)
      ctx.fillStyle = PANEL
      ctx.fillRect(0, 27, VIEW_W, 4)
      ctx.fillStyle = METAL_DARK
      ctx.fillRect(0, 16, VIEW_W, 4)
      ctx.fillStyle = METAL
      ctx.fillRect(0, 16, VIEW_W, 1)
      const bracketOffset = -((worldX * 0.5) % 80)
      ctx.fillStyle = METAL_DARK
      for (let i = 0; i < 6; i += 1) ctx.fillRect(Math.round(bracketOffset + i * 80), 13, 2, 9)
      const lightOffset = -((worldX * 0.5) % 160)
      ctx.fillStyle = PANEL
      for (let i = 0; i < 3; i += 1) {
        drawLightStrip(ctx, Math.round(lightOffset + i * 160 + 30), 6, 88, now, i + 1)
      }
      // 垂下的线缆
      const cableOffset = -((worldX * 0.75) % 230)
      for (let i = 0; i < 3; i += 1) {
        const x = Math.round(cableOffset + i * 230 + 70)
        const sway = Math.round(Math.sin(now / 1000 + i) * 2)
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(x, 20, 1, 24)
        ctx.fillRect(x + sway, 44, 1, 14)
        ctx.fillRect(x - 2 + sway, 58, 4, 3)
        ctx.fillStyle = METAL
        ctx.fillRect(x - 2 + sway, 58, 4, 1)
      }
    }

    function drawFloor(ctx, worldX, now) {
      ctx.fillStyle = FLOOR
      ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y)
      // 地面导光带
      const stripOffset = -((worldX) % 120)
      for (let i = 0; i < 5; i += 1) {
        const x = Math.round(stripOffset + i * 120 + 12)
        ctx.fillStyle = CYAN
        ctx.fillRect(x, GROUND_Y, 42, 1)
        ctx.globalAlpha = 0.16
        ctx.fillStyle = CYAN
        ctx.fillRect(x, GROUND_Y + 1, 42, 3)
        ctx.globalAlpha = 1
      }
      // 抛光地砖
      const tileOffset = -((worldX) % 44)
      for (let i = 0; i < 12; i += 1) {
        const x = Math.round(tileOffset + i * 44)
        const dark = (Math.floor(-tileOffset / 44) + i) % 2 === 0
        ctx.fillStyle = dark ? FLOOR_TILE : FLOOR
        ctx.fillRect(x, GROUND_Y + 2, 43, VIEW_H - GROUND_Y - 2)
        ctx.fillStyle = '#1b3546'
        ctx.fillRect(x + 43, GROUND_Y + 2, 1, VIEW_H - GROUND_Y - 2)
        ctx.fillStyle = '#1b3546'
        ctx.fillRect(x + 1, GROUND_Y + 30, 41, 1)
        if ((i + Math.floor(worldX / 44)) % 5 === 0) {
          ctx.fillStyle = '#0b141c'
          ctx.fillRect(x + 10, GROUND_Y + 16, 8, 2)
          ctx.fillRect(x + 28, GROUND_Y + 24, 3, 1)
        }
      }
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
        ctx.fillRect(x + sway, 30, 2, 22)
        ctx.fillRect(x - 1 + sway, 51, 4, 3)
        ctx.fillStyle = '#2f4a5f'
        ctx.fillRect(x - 1 + sway, 51, 4, 1)
      }
      // 数据粒子
      for (let i = 0; i < 10; i += 1) {
        const x = (i * 73 + Math.round(worldX * 0.3)) % VIEW_W
        const y = 38 + ((i * 41 + Math.floor(now / 50)) % 132)
        ctx.fillStyle = i % 3 === 0 ? WHITE_LIGHT : CYAN_DIM
        ctx.fillRect(x, y, 1, 1)
      }
    }

    function drawBackground(ctx, game, now) {
      const worldX = game.distance * 10
      const sector = (sectorOf(game.distance) - 1) % 3
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
      drawSectorBack(ctx, sector, worldX, now)
      drawFloor(ctx, worldX, now)
      drawCeiling(ctx, worldX, now)
      drawForeground(ctx, worldX, now)
    }

    function drawToken(ctx, token, now) {
      const bob = Math.round(Math.sin(now / 180 + token.phase) * 2)
      const x = Math.round(token.x)
      const y = Math.round(token.y + bob)
      ctx.fillStyle = 'rgba(103,232,214,.10)'
      ctx.fillRect(x - 8, y - 8, 16, 16)
      ctx.fillStyle = 'rgba(103,232,214,.16)'
      ctx.fillRect(x - 6, y - 6, 12, 12)
      const rows = [
        [4, 2],
        [2, 6],
        [1, 8],
        [0, 10],
        [1, 8],
        [2, 6],
        [4, 2],
      ]
      ctx.fillStyle = TOKEN.main
      for (let i = 0; i < rows.length; i += 1) {
        const [offset, width] = rows[i]
        ctx.fillRect(x - 5 + offset, y - 3 + i, width, 1)
      }
      ctx.fillStyle = TOKEN.hi
      ctx.fillRect(x - 2, y - 2, 2, 2)
      ctx.fillStyle = TOKEN.dark
      ctx.fillRect(x + 2, y + 1, 2, 1)
      if (Math.floor(now / 200 + token.phase) % 4 === 0) {
        ctx.fillStyle = TOKEN.hi
        ctx.fillRect(x + 6, y - 6, 1, 1)
      }
    }

    function drawObstacle(ctx, obstacle, now) {
      const x = Math.round(obstacle.x)
      const width = obstacle.type === 'low' ? LOW_W : HIGH_W
      ctx.fillStyle = '#050b11'
      ctx.fillRect(x + 1, GROUND_Y + 1, width - 2, 2)
      if (obstacle.type === 'low') {
        // 倒下的服务器机箱 / 机架模块
        ctx.globalAlpha = 0.14
        ctx.fillStyle = CRATE.stripe
        ctx.fillRect(x - 4, GROUND_Y - LOW_H - 4, LOW_W + 8, LOW_H + 8)
        ctx.globalAlpha = 1
        ctx.fillStyle = '#05090d'
        ctx.fillRect(x - 1, GROUND_Y - LOW_H - 1, LOW_W + 2, LOW_H + 1)
        ctx.fillStyle = CRATE.dark
        ctx.fillRect(x, GROUND_Y - LOW_H, LOW_W, LOW_H)
        ctx.fillStyle = CRATE.main
        ctx.fillRect(x + 2, GROUND_Y - LOW_H + 2, LOW_W - 4, LOW_H - 4)
        ctx.fillStyle = CRATE.hi
        ctx.fillRect(x + 3, GROUND_Y - LOW_H + 3, LOW_W - 6, 2)
        ctx.fillStyle = '#172531'
        for (let row = 0; row < 2; row += 1) {
          ctx.fillRect(x + 5, GROUND_Y - LOW_H + 8 + row * 4, LOW_W - 10, 1)
        }
        // 黄黑警示条
        ctx.fillStyle = CRATE.stripe
        ctx.fillRect(x + 4, GROUND_Y - 10, LOW_W - 8, 3)
        ctx.fillStyle = '#17202a'
        for (let i = 0; i < 3; i += 1) ctx.fillRect(x + 7 + i * 8, GROUND_Y - 10, 3, 3)
        // 侧板散热 + LED
        ctx.fillStyle = '#0e1a24'
        for (let i = 0; i < 3; i += 1) ctx.fillRect(x + 5, GROUND_Y - 18 + i * 2, 7, 1)
        ctx.fillStyle = CYAN
        ctx.fillRect(x + LOW_W - 9, GROUND_Y - LOW_H + 5, 2, 2)
        ctx.fillStyle = METAL_HI
        ctx.fillRect(x + LOW_W - 6, GROUND_Y - LOW_H + 2, 3, 5)
      } else {
        // 悬挂式安全激光门：滑铲从光束下穿过
        const top = HIGH_TOP
        const bottom = HIGH_BOTTOM
        ctx.fillStyle = METAL_DARK
        ctx.fillRect(x - 6, top - 10, HIGH_W + 12, 5)
        ctx.fillStyle = METAL
        ctx.fillRect(x - 6, top - 10, HIGH_W + 12, 2)
        ctx.fillStyle = PANEL_LIGHT
        ctx.fillRect(x - 2, top - 5, 4, bottom - top + 9)
        ctx.fillRect(x + HIGH_W - 2, top - 5, 4, bottom - top + 9)
        ctx.fillStyle = LASER.post
        ctx.fillRect(x - 5, top - 4, 2, bottom - top + 6)
        ctx.fillRect(x + HIGH_W + 3, top - 4, 2, bottom - top + 6)
        // 发射器
        ctx.fillStyle = LASER.postHi
        ctx.fillRect(x - 5, bottom - 2, 9, 8)
        ctx.fillRect(x + HIGH_W - 4, bottom - 2, 9, 8)
        // 光束光晕 + 主体
        const pulse = 0.5 + Math.abs(Math.sin(now / 180)) * 0.5
        ctx.globalAlpha = 0.12 * pulse
        ctx.fillStyle = LASER.beam
        ctx.fillRect(x - 2, bottom - 4, HIGH_W + 4, 18)
        ctx.globalAlpha = 0.5 + pulse * 0.5
        ctx.fillRect(x + 2, bottom - 1, HIGH_W - 4, 2)
        ctx.globalAlpha = 1
        ctx.fillStyle = LASER.beam
        ctx.fillRect(x + 3, bottom, HIGH_W - 6, 1)
        ctx.fillStyle = '#ffd0d0'
        const dashShift = Math.floor(now / 60) % 8
        for (let i = 0; i < 5; i += 1) {
          ctx.fillRect(x + 4 + ((i * 8 + dashShift) % (HIGH_W - 8)), bottom, 2, 1)
        }
        ctx.fillStyle = laserBlink(now) ? LED_RED : '#5a2024'
        ctx.fillRect(x + Math.round(HIGH_W / 2) - 2, top - 8, 4, 3)
      }
    }

    function laserBlink(now) {
      return Math.floor(now / 240) % 4 !== 0
    }

    function drawClawd(ctx, game, now) {
      const player = game.player
      const x = PLAYER_X
      const feet = Math.round(GROUND_Y + player.y)
      const sliding = player.sliding
      const airborne = player.y < 0
      const phase = Math.floor(player.anim * 8) % 2
      const bob = airborne || sliding ? 0 : (Math.floor(player.anim * 8) % 4 < 2 ? 0 : 1)
      const bodyW = 24
      const bodyH = 18
      const bodyLeft = x - bodyW / 2
      const bodyTop = sliding ? feet - 12 : feet - 24 + bob
      const bodyHeight = sliding ? 12 : bodyH
      const bodyColor = '#d97757'
      const shade = '#b45f41'
      const light = '#e88b6a'
      if (!airborne) {
        ctx.fillStyle = '#170f09'
        ctx.fillRect(x - 13, GROUND_Y + 1, 26, 2)
      }
      // 四条腿（先画，压在身体下面；顶端固定接在身体底边，不再和身体断开）
      const bodyBottom = bodyTop + bodyHeight
      if (sliding) {
        ctx.fillStyle = shade
        ctx.fillRect(bodyLeft + 1, feet - 4, 5, 4)
        ctx.fillRect(bodyLeft + bodyW - 7, feet - 4, 6, 4)
        ctx.fillStyle = bodyColor
        ctx.fillRect(bodyLeft + 2, feet - 6, 4, 3)
        ctx.fillRect(bodyLeft + bodyW - 6, feet - 6, 4, 3)
      } else {
        const legOffsets = [2, 8, 14, 20]
        for (let i = 0; i < legOffsets.length; i += 1) {
          const swing = airborne ? 2 : (i % 2 === phase ? 1 : 0)
          const top = bodyBottom - 1
          const bottom = feet - (airborne ? 3 : swing)
          if (bottom <= top) continue
          ctx.fillStyle = shade
          ctx.fillRect(bodyLeft + legOffsets[i], top, 2, bottom - top)
          ctx.fillStyle = bodyColor
          ctx.fillRect(bodyLeft + legOffsets[i], top, 1, Math.max(1, bottom - top - 1))
          ctx.fillStyle = shade
          ctx.fillRect(bodyLeft + legOffsets[i] - 1, bottom - 1, 4, 1)
        }
      }
      // 手臂（中段，左右各一截）
      const armY = bodyTop + Math.floor(bodyHeight / 2) - 1
      ctx.fillStyle = bodyColor
      ctx.fillRect(bodyLeft - 5, armY, 5, 3)
      ctx.fillRect(bodyLeft + bodyW, armY, 5, 3)
      ctx.fillStyle = shade
      ctx.fillRect(bodyLeft - 5, armY + 2, 5, 1)
      ctx.fillRect(bodyLeft + bodyW, armY + 2, 5, 1)
      // 方身体
      ctx.fillStyle = bodyColor
      ctx.fillRect(bodyLeft, bodyTop, bodyW, bodyHeight)
      ctx.fillStyle = light
      ctx.fillRect(bodyLeft + 1, bodyTop + 1, bodyW - 2, 1)
      ctx.fillStyle = shade
      ctx.fillRect(bodyLeft, bodyTop + bodyHeight - 2, bodyW, 2)
      // 两根触角 + 白色尖端
      const antennaY = bodyTop - 6
      ctx.fillStyle = shade
      ctx.fillRect(bodyLeft + 5, antennaY, 1, 6)
      ctx.fillRect(bodyLeft + bodyW - 6, antennaY, 1, 6)
      ctx.fillStyle = '#f4f0e8'
      ctx.fillRect(bodyLeft + 4, antennaY - 2, 3, 2)
      ctx.fillRect(bodyLeft + bodyW - 7, antennaY - 2, 3, 2)
      // 两只方形眼睛，没嘴巴
      ctx.fillStyle = '#1a1a1a'
      const eyeY = bodyTop + (sliding ? 3 : 5)
      const eyeOffset = sliding ? 8 : 6
      ctx.fillRect(bodyLeft + eyeOffset, eyeY, 3, 3)
      ctx.fillRect(bodyLeft + bodyW - eyeOffset - 3, eyeY, 3, 3)
      // 跑动时脚边的小尘土
      if (!airborne && !sliding && (Math.floor(player.anim * 8) % 6 === 0)) {
        ctx.fillStyle = '#6b5238'
        ctx.fillRect(bodyLeft - 2, feet - 1, 2, 1)
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

    /** 达里奥直接用用户给的 Running-Dario.gif 拆帧精灵表。 */
    function drawDario(ctx, game, now) {
      const x = Math.round(PLAYER_X - game.gap)
      if (x < -80) return
      const height = game.gap < 35 ? 50 : 46
      const width = Math.round((DARIO_FRAME_W * height) / DARIO_FRAME_H)
      // 地面投影
      ctx.fillStyle = '#1a120b'
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
      '.cr-title{font-size:30px;font-weight:800;line-height:1;letter-spacing:.04em;color:var(--dsw-alias-label-primary,inherit)}',
      '.cr-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-sector{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:4px;border:1px solid rgba(103,232,214,.45);background:#0b1a26;font-size:10px;letter-spacing:.08em;color:#9ff5e8;vertical-align:1px;font-variant-numeric:tabular-nums}',
      '.cr-stats{display:flex;gap:7px;flex-wrap:wrap}',
      '.cr-stat{min-width:62px;padding:6px 9px;border-radius:10px;box-sizing:border-box;text-align:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.cr-stat-k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-stat-v{font-size:16px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.cr-stat.is-best .cr-stat-v{color:#849b64}',
      '.cr-stat.is-token .cr-stat-v{color:#4fb3a5}',
      '.cr-chase{display:flex;align-items:center;gap:10px;padding:7px 11px;border-radius:10px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',
      '.cr-chase-label{flex:0 0 auto;font-size:11px;font-weight:700;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-chase-track{flex:1 1 auto;height:8px;border-radius:999px;overflow:hidden;background:rgba(127,127,127,.18)}',
      '.cr-chase-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#67e8d6,#3f9d8b);transition:width 120ms linear,background 200ms ease}',
      '.cr-chase.is-warn .cr-chase-fill{background:linear-gradient(90deg,#f2c14e,#c98c22)}',
      '.cr-chase.is-danger .cr-chase-fill{background:linear-gradient(90deg,#f25f5c,#a63b3b)}',
      '.cr-chase-pct{flex:0 0 auto;min-width:38px;text-align:right;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-aquarium{position:relative;width:100%;box-sizing:border-box;padding:10px;border-radius:18px;background:linear-gradient(180deg,#17231c,#0a120e);border:1px solid rgba(255,255,255,.08);box-shadow:0 24px 48px rgba(0,0,0,.34),inset 0 1px 0 rgba(255,255,255,.06)}',
      '.cr-screen-slot{position:relative;display:flex;justify-content:center;align-items:center;width:100%;min-height:120px}',
      '.cr-canvas{display:block;image-rendering:pixelated;background:#07110d;border-radius:8px;touch-action:none;user-select:none;-webkit-user-select:none;box-shadow:0 0 30px rgba(80,180,140,.12),inset 0 0 0 1px rgba(140,200,170,.12);cursor:pointer}',
      '.cr-page:fullscreen{height:100vh;padding:10px 14px;background:var(--dsw-alias-bg-layer-1,#0b1210);box-sizing:border-box}',
      '.cr-page:fullscreen .cr-shell{width:min(100%,1600px)}',
      '.cr-overlay{position:absolute;inset:10px;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(4,10,7,.6);border-radius:8px;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);animation:cr-fade 160ms ease-out}',
      '@keyframes cr-fade{from{opacity:0}to{opacity:1}}',
      '.cr-card{display:flex;flex-direction:column;align-items:center;gap:8px;width:min(100%,350px);padding:20px 18px 16px;box-sizing:border-box;text-align:center;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#161f28);border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));box-shadow:0 18px 46px rgba(0,0,0,.36);animation:cr-card-in 190ms cubic-bezier(.2,.75,.3,1)}',
      '@keyframes cr-card-in{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '.cr-card-title{font-size:26px;font-weight:900;line-height:1.15;letter-spacing:.03em;color:var(--dsw-alias-label-primary,inherit)}',
      '.cr-card-note{max-width:290px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-card-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:7px;margin-top:4px}',
      '.cr-toast{position:absolute;left:50%;top:22px;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#101820);border:1px solid rgba(103,232,214,.4);color:#9ff5e8;font-size:12px;font-weight:700;pointer-events:none;animation:cr-toast 1.2s ease-out forwards}',
      '@keyframes cr-toast{0%{opacity:0;transform:translate(-50%,6px)}14%{opacity:1;transform:translate(-50%,0)}78%{opacity:1}100%{opacity:0;transform:translate(-50%,-6px)}}',
      '.cr-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.cr-hint{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-actions{display:flex;gap:7px;flex-wrap:wrap}',
      '.cr-btn{appearance:none;padding:6px 13px;border-radius:9px;font:inherit;font-size:12.5px;font-weight:600;line-height:1.2;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));transition:background 120ms ease,border-color 120ms ease,transform 80ms ease}',
      '.cr-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.2));border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.4))}',
      '.cr-btn:active:not(:disabled){transform:translateY(1px)}',
      '.cr-btn:disabled{opacity:.42;cursor:default;transform:none}',
      '.cr-btn.is-on{border-color:rgba(47,159,146,.7);color:#2f9f92}',
      '.cr-btn.is-primary{background:linear-gradient(135deg,#8fd6c6,#3f9d8b);border-color:transparent;color:#06222a;box-shadow:0 2px 8px rgba(63,157,139,.28)}',
      '.cr-btn.is-primary:hover:not(:disabled){background:linear-gradient(135deg,#a0e2d2,#4aab98)}',
      '.cr-btn:focus-visible,.cr-canvas:focus-visible{outline:2px solid #7fd0c0;outline-offset:2px}',
      '@media (max-width:600px){.cr-page{padding:12px 12px 16px}.cr-title{font-size:26px}.cr-stat{min-width:48px;padding:5px 6px}.cr-stat-v{font-size:13px;line-height:1.25}.cr-stat-k{font-size:8.5px}.cr-aquarium{padding:7px}.cr-overlay{inset:7px}.cr-hint{font-size:10.5px}}',
      '@media (prefers-reduced-motion:reduce){.cr-overlay,.cr-card,.cr-toast{animation:none}}',
    ].join('\n')

    // ── 文案 ────────────────────────────────────────────────────────────────
    const ZH = {
      'nav.label': 'Clawd 逃亡',
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
      'overlay.ready.title': 'Clawd 逃亡',
      'overlay.ready.note': '跳过安全路障、滑过审查横幅，捡 token 拉开和达里奥的距离。空格/↑ 跳，↓ 滑，P 暂停。',
      'overlay.paused.title': '暂停',
      'overlay.paused.note': '按空格或点「继续」，Clawd 先喘口气。',
      'overlay.over.title': '被达里奥抓住了',
      'overlay.over.note': '得分 {score} · 最高 {best}',
      'overlay.over.stats': '跑了 {distance}m · 捡了 {tokens} 个 token',
      'toast.hit': '差点被抓住！',
      'toast.milestone': '{distance}m！',
      'hint.keys': '空格 / ↑ 跳跃 · ↓ 滑铲 · P 暂停',
      'hint.touch': '点画面跳跃 · 点「滑铲」下蹲',
      'board.label': 'Clawd 逃亡游戏画面',
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
      'overlay.ready.title': 'Clawd Run',
      'overlay.ready.note': 'Hop the safety rails, slide under review banners, and grab tokens to keep Dario off your tail. Space/Up to jump, Down to slide, P to pause.',
      'overlay.paused.title': 'Paused',
      'overlay.paused.note': 'Press Space or Resume — Clawd can catch a breath.',
      'overlay.over.title': 'Dario caught you',
      'overlay.over.note': 'Score {score} · best {best}',
      'overlay.over.stats': 'Ran {distance}m · grabbed {tokens} tokens',
      'toast.hit': 'Almost caught!',
      'toast.milestone': '{distance}m!',
      'hint.keys': 'Space / Up to jump · Down to slide · P to pause',
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
          if (key === 'ArrowDown' || key === 's' || key === 'S') {
            event.preventDefault()
            if (status === 'running') slideNow()
            return
          }
          if (key === 'p' || key === 'P') {
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
          return h('div', { className: 'cr-overlay' },
            h('div', { className: 'cr-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('overlay.ready.title') },
              h('div', { className: 'cr-card-title' }, t('overlay.ready.title')),
              h('div', { className: 'cr-card-note' }, t('overlay.ready.note')),
              h('div', { className: 'cr-card-actions' },
                h('button', { type: 'button', className: 'cr-btn is-primary', onClick: primary }, t('action.start')),
              ),
            ),
          )
        }
        if (game.status === 'paused') {
          return h('div', { className: 'cr-overlay' },
            h('div', { className: 'cr-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('overlay.paused.title') },
              h('div', { className: 'cr-card-title' }, t('overlay.paused.title')),
              h('div', { className: 'cr-card-note' }, t('overlay.paused.note')),
              h('div', { className: 'cr-card-actions' },
                h('button', { type: 'button', className: 'cr-btn is-primary', onClick: primary }, t('action.resume')),
              ),
            ),
          )
        }
        if (game.status === 'over') {
          return h('div', { className: 'cr-overlay' },
            h('div', { className: 'cr-card', role: 'dialog', 'aria-modal': 'false', 'aria-label': t('overlay.over.title') },
              h('div', { className: 'cr-card-title' }, t('overlay.over.title')),
              h('div', { className: 'cr-card-note' }, fmt('overlay.over.note', { score: game.score, best: liveBest })),
              h('div', { className: 'cr-card-note' }, fmt('overlay.over.stats', { distance, tokens: game.tokens })),
              h('div', { className: 'cr-card-actions' },
                h('button', { type: 'button', className: 'cr-btn is-primary', onClick: newGameNow }, t('action.again')),
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
          h(
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
            h(
              'div',
              { className: 'cr-stats' },
              stat(t('stat.score'), game.score),
              stat(t('stat.best'), liveBest, 'is-best'),
              stat(t('stat.tokens'), game.tokens, 'is-token'),
              stat(t('stat.distance'), distance + 'm'),
            ),
          ),
          h(
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
          h(
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
