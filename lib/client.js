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
    const VIEW_W = 480
    const VIEW_H = 270
    const GROUND_Y = 214
    const PLAYER_X = 132
    const PLAYER_W = 26
    const PLAYER_H = 30
    const SLIDE_H = 13
    const GRAVITY = 1500
    const JUMP_V = -440
    const SLIDE_TIME = 0.55
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

    /** 生成一串 token：直线（胸部高度）/ 抛物线（要跳起来吃）/ 低空（滑铲顺手吃）。 */
    function createTokenPattern(rngState, nextId, startX) {
      let state = rngState >>> 0
      const rand = () => { const step = nextRandom(state); state = step.state; return step.value }
      let id = nextId
      const tokens = []
      const roll = rand()
      if (roll < 0.42) {
        for (let i = 0; i < 4; i += 1) {
          tokens.push({ id: id++, x: startX + i * 22, y: GROUND_Y - 34, phase: rand() * Math.PI * 2 })
        }
      } else if (roll < 0.8) {
        const heights = [GROUND_Y - 22, GROUND_Y - 38, GROUND_Y - 52, GROUND_Y - 38, GROUND_Y - 22]
        for (let i = 0; i < heights.length; i += 1) {
          tokens.push({ id: id++, x: startX + i * 22, y: heights[i], phase: rand() * Math.PI * 2 })
        }
      } else {
        for (let i = 0; i < 3; i += 1) {
          tokens.push({ id: id++, x: startX + i * 20, y: GROUND_Y - 16, phase: rand() * Math.PI * 2 })
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
      for (const startX of [330, 470]) {
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

      // 障碍：保证不会在屏幕右缘叠在一起
      next.spawnTimer = game.spawnTimer - step
      if (next.spawnTimer <= 0) {
        if (!next.obstacles.some((obstacle) => obstacle.x > VIEW_W - 60)) {
          const created = createObstacle(rngState, next.nextId, VIEW_W + 40)
          rngState = created.rngState
          next.obstacles.push(created.obstacle)
          next.nextId += 1
          next.spawnTimer = clamp(1.45 - next.distance * 0.0004, 0.7, 1.45) + rand() * 0.4
        } else {
          next.spawnTimer = 0.25
        }
      }
      // token 串
      next.tokenTimer = game.tokenTimer - step
      if (next.tokenTimer <= 0) {
        const created = createTokenPattern(rngState, next.nextId, VIEW_W + 30)
        rngState = created.rngState
        next.nextId = created.nextId
        for (const token of created.tokens) next.tokensList.push(token)
        next.tokenTimer = 0.7 + rand() * 0.45
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
        h('rect', { width: 32, height: 32, rx: 7, fill: '#12251f' }),
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

    // ── 画面：480×270 像素神殿 ──────────────────────────────────────────────
    const SKY = ['#07110d', '#0a1611', '#0e1d16']
    const FAR_COLOR = '#0c1a14'
    const WALL = '#241a13'
    const WALL_LINE = '#2e2219'
    const COLUMN = '#3d2c20'
    const COLUMN_HI = '#5b4130'
    const FLOOR = '#2a1c12'
    const FLOOR_HI = '#4a3220'
    const TORCH = '#ffb15c'
    const TORCH2 = '#e8873a'
    const TOKEN = { main: '#67e8d6', hi: '#d9fff8', dark: '#2f9f92' }
    const STONE = { main: '#5a4633', hi: '#7a6248', dark: '#3a2a1d' }
    const BANNER = { cloth: '#a63b3b', hi: '#c95a5a', pole: '#6b4c32' }
    const CLAWD = { body: '#e8875a', dark: '#b85f3a', belly: '#f6d3b3', eye: '#141414' }
    const DARIO = { suit: '#2b2f3a', suitHi: '#3a4050', shirt: '#d9d4c7', tie: '#b33a3a', skin: '#d9a77c', hair: '#2a2220', glasses: '#111820' }
    const DUST = '#8a7050'

    function drawBackground(ctx, game, now) {
      const bandH = Math.ceil(VIEW_H / SKY.length)
      for (let i = 0; i < SKY.length; i += 1) {
        ctx.fillStyle = SKY[i]
        ctx.fillRect(0, i * bandH, VIEW_W, bandH + 1)
      }
      const worldX = game.distance * 10
      // 远景拱门
      ctx.fillStyle = FAR_COLOR
      const farOffset = -((worldX * 0.25) % 200)
      for (let i = 0; i < 5; i += 1) {
        const x = Math.round(farOffset + i * 200)
        ctx.fillRect(x + 24, 46, 14, GROUND_Y - 46)
        ctx.fillRect(x + 120, 46, 14, GROUND_Y - 46)
        ctx.fillRect(x + 24, 38, 110, 10)
      }
      // 石墙
      ctx.fillStyle = WALL
      ctx.fillRect(0, 0, VIEW_W, GROUND_Y)
      ctx.fillStyle = WALL_LINE
      for (let y = 28; y < GROUND_Y; y += 26) ctx.fillRect(0, y, VIEW_W, 1)
      // 中景柱子和火把
      const midOffset = -((worldX * 0.55) % 220)
      for (let i = 0; i < 4; i += 1) {
        const x = Math.round(midOffset + i * 220)
        ctx.fillStyle = COLUMN
        ctx.fillRect(x, 26, 26, GROUND_Y - 26)
        ctx.fillStyle = COLUMN_HI
        ctx.fillRect(x + 3, 26, 4, GROUND_Y - 26)
        ctx.fillRect(x, 26, 26, 5)
        ctx.fillStyle = TORCH2
        ctx.fillRect(x + 30, 80, 3, 12)
        const flicker = Math.round(Math.sin(now / 90 + i) * 1.5)
        ctx.fillStyle = TORCH
        ctx.fillRect(x + 29, 72 + flicker, 5, 8)
        ctx.fillStyle = '#ffd9a0'
        ctx.fillRect(x + 30, 74 + flicker, 2, 4)
      }
      // 地面
      ctx.fillStyle = FLOOR
      ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y)
      ctx.fillStyle = FLOOR_HI
      ctx.fillRect(0, GROUND_Y, VIEW_W, 3)
      const tileOffset = -((worldX) % 48)
      ctx.fillStyle = '#1f140c'
      for (let i = 0; i < 12; i += 1) {
        const x = Math.round(tileOffset + i * 48)
        ctx.fillRect(x, GROUND_Y + 3, 1, VIEW_H - GROUND_Y)
      }
      ctx.fillStyle = '#3a281a'
      ctx.fillRect(0, GROUND_Y + 30, VIEW_W, 2)
      // 漂浮尘埃
      ctx.fillStyle = '#4a3a2a'
      for (const bubble of game.bubbles) {
        ctx.fillRect(Math.round(bubble.x), Math.round(bubble.y), bubble.r, 1)
      }
    }

    function drawToken(ctx, token, now) {
      const bob = Math.round(Math.sin(now / 180 + token.phase) * 2)
      const x = Math.round(token.x)
      const y = Math.round(token.y + bob)
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
      if (obstacle.type === 'low') {
        ctx.fillStyle = STONE.dark
        ctx.fillRect(x, GROUND_Y - LOW_H, LOW_W, LOW_H)
        ctx.fillStyle = STONE.main
        ctx.fillRect(x + 2, GROUND_Y - LOW_H + 2, LOW_W - 4, LOW_H - 4)
        ctx.fillStyle = STONE.hi
        ctx.fillRect(x + 3, GROUND_Y - LOW_H + 3, LOW_W - 6, 2)
        ctx.fillStyle = BANNER.cloth
        ctx.fillRect(x + 4, GROUND_Y - LOW_H + 7, LOW_W - 8, 3)
        ctx.fillStyle = '#f6e2c8'
        ctx.fillRect(x + 6, GROUND_Y - LOW_H + 8, 2, 1)
        ctx.fillRect(x + 11, GROUND_Y - LOW_H + 8, 2, 1)
        ctx.fillRect(x + 16, GROUND_Y - LOW_H + 8, 2, 1)
        ctx.fillStyle = STONE.dark
        ctx.fillRect(x + 8, GROUND_Y - 8, 1, 5)
        ctx.fillRect(x + 18, GROUND_Y - 14, 1, 6)
      } else {
        const sway = Math.round(Math.sin(now / 320 + obstacle.id) * 1)
        ctx.fillStyle = BANNER.pole
        ctx.fillRect(x - 4, HIGH_TOP - 3, HIGH_W + 8, 3)
        ctx.fillStyle = BANNER.cloth
        ctx.fillRect(x + sway, HIGH_TOP, HIGH_W, HIGH_BOTTOM - HIGH_TOP)
        ctx.fillStyle = BANNER.hi
        ctx.fillRect(x + 3 + sway, HIGH_TOP + 4, 4, HIGH_BOTTOM - HIGH_TOP - 10)
        ctx.fillStyle = '#f6e2c8'
        const cx = x + Math.round(HIGH_W / 2) + sway
        const cy = HIGH_TOP + Math.round((HIGH_BOTTOM - HIGH_TOP) / 2)
        for (let i = 0; i < 6; i += 1) {
          ctx.fillRect(cx - i, cy - 8 + i, 1 + i * 2, 1)
        }
        ctx.fillRect(cx - 1, cy + 6, 2, 2)
      }
    }

    /** Clawd 本体：8×6 方身体 + 两只方眼 + 四腿 + 中段手臂 + 白尖触角，官方橙 #d97757。 */
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
      // 四条腿（先画，压在身体下面）
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
          const lift = airborne ? 3 : (i % 2 === phase ? 2 : 0)
          ctx.fillStyle = shade
          ctx.fillRect(bodyLeft + legOffsets[i], feet - 6 + lift, 2, 6 - lift)
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

    function drawDario(ctx, game, now) {
      const x = Math.round(PLAYER_X - game.gap)
      if (x < -50) return
      const feet = GROUND_Y
      const phase = Math.floor((game.time * 9) % 4)
      const lean = game.gap < 35 ? 3 : 0
      ctx.fillStyle = DARIO.suit
      ctx.fillRect(x - 10 + lean, feet - 34, 20, 22)
      ctx.fillStyle = DARIO.suitHi
      ctx.fillRect(x + 4 + lean, feet - 32, 4, 16)
      ctx.fillStyle = DARIO.shirt
      ctx.fillRect(x - 2 + lean, feet - 34, 6, 12)
      ctx.fillStyle = DARIO.tie
      ctx.fillRect(x + 1 + lean, feet - 30, 2, 8)
      // 头
      ctx.fillStyle = DARIO.hair
      ctx.fillRect(x - 6 + lean, feet - 44, 13, 7)
      ctx.fillStyle = DARIO.skin
      ctx.fillRect(x - 5 + lean, feet - 39, 11, 8)
      ctx.fillStyle = DARIO.glasses
      ctx.fillRect(x - 4 + lean, feet - 37, 4, 2)
      ctx.fillRect(x + 1 + lean, feet - 37, 4, 2)
      ctx.fillStyle = DARIO.hair
      ctx.fillRect(x - 4 + lean, feet - 42, 3, 1)
      ctx.fillRect(x + 2 + lean, feet - 42, 3, 1)
      // 腿
      ctx.fillStyle = DARIO.suit
      if (phase < 2) {
        ctx.fillRect(x - 8, feet - 12, 5, 12)
        ctx.fillRect(x + 4, feet - 12, 5, 12)
      } else {
        ctx.fillRect(x - 10, feet - 12, 5, 12)
        ctx.fillRect(x + 2, feet - 12, 5, 12)
      }
      // 伸出的手
      if (game.gap < 55) {
        ctx.fillStyle = DARIO.skin
        ctx.fillRect(x + 14 - Math.round(game.gap / 3), feet - 26, 8, 3)
      }
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
      '.cr-page{height:100%;min-height:0;overflow:auto;display:flex;padding:18px 22px 24px;box-sizing:border-box;background:transparent}',
      '.cr-shell{margin:auto;width:min(100%,1040px);display:flex;flex-direction:column;gap:12px}',
      '.cr-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}',
      '.cr-brand{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.cr-wordmark{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.cr-logo{display:flex;flex:0 0 auto}',
      '.cr-title{font-size:30px;font-weight:800;line-height:1;letter-spacing:.04em;color:var(--dsw-alias-label-primary,inherit)}',
      '.cr-sub{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-stats{display:flex;gap:7px;flex-wrap:wrap}',
      '.cr-stat{min-width:62px;padding:6px 9px;border-radius:10px;box-sizing:border-box;text-align:center;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.cr-stat-k{font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9a9a9a)}',
      '.cr-stat-v{font-size:16px;font-weight:700;line-height:1.3;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,inherit)}',
      '.cr-stat.is-best .cr-stat-v{color:#849b64}',
      '.cr-stat.is-token .cr-stat-v{color:#67e8d6}',
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
      '.cr-btn.is-on{border-color:rgba(127,208,192,.6);color:#7fd0c0}',
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
      'action.start': '开始',
      'action.pause': '暂停',
      'action.resume': '继续',
      'action.new': '新局',
      'action.again': '再来一局',
      'action.jump': '跳跃',
      'action.slide': '滑铲',
      'action.soundOn': '音效 开',
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
      'action.start': 'Start',
      'action.pause': 'Pause',
      'action.resume': 'Resume',
      'action.new': 'New game',
      'action.again': 'Play again',
      'action.jump': 'Jump',
      'action.slide': 'Slide',
      'action.soundOn': 'Sound on',
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
          const heightLimit = Math.max(VIEW_H, window.innerHeight - 240)
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
        { className: 'cr-page' },
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
              h('div', { className: 'cr-sub' }, t('panel.subtitle')),
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
