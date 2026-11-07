/**
 * Clawd 快跑外壳自检（不需要浏览器）：
 *   1. lib/client.js 在最简 window / React 桩下能被模块加载器收下并 apply 出两个槽位；
 *   2. 装了游戏厅时只向游戏厅登记，不再注册独立槽位；
 *   3. 中英文案键一致，t()/fmt() 用到的键都有翻译；
 *   4. 清单字段、bundle patch、locale 元数据、CSS 前缀、存档键、内核标记齐全。
 *
 * 跑法：node test/plugin.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
}

function loadModule() {
  let definition = null
  const fakeWindow = { __ModuleLoader__: { load: (def) => { definition = def } } }
  // eslint-disable-next-line no-new-func
  const runModule = new Function('window', source)
  runModule(fakeWindow)
  assert.ok(definition, '模块把定义交给了 __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-plugin-clawd-run')
  const mod = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  assert.ok(mod && typeof mod.apply === 'function')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('slots'))
  assert.ok(mod.inject.includes('locale'))
  return { mod, fakeWindow }
}

function makeCtx(registrations, localeRegistrations, cleanups) {
  return {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return cleanup
    },
    get() { return undefined },
    locale: {
      register: (ns, locale) => { localeRegistrations.push([ns, locale]); return () => {} },
      bind: () => (key) => key,
      subscribe: () => () => {},
    },
    slots: {
      inject: (key, callback) => callback(),
      register(options, component) {
        registrations.push({ slot: options.name, options, component })
        return () => {}
      },
    },
  }
}

test('client.js 能在模块加载器桩下加载并返回 apply', () => {
  loadModule()
})

test('apply 注册了侧栏图标与主面板，并注册中英文字典', () => {
  const { mod } = loadModule()
  const registrations = []
  const localeRegistrations = []
  const cleanups = []
  mod.apply(makeCtx(registrations, localeRegistrations, cleanups))

  const sidebar = registrations.find((row) => row.slot === 'sidebar.panellist')
  const main = registrations.find((row) => row.slot === 'main')
  assert.ok(sidebar, '注册了 sidebar.panellist')
  assert.ok(main, '注册了 main')
  assert.equal(sidebar.options.id, 'dsh-clawd-run')
  assert.equal(main.options.key, 'dsh-clawd-run')
  assert.equal(sidebar.options.order, 51)
  assert.equal(sidebar.options.label(), 'nav.label')
  assert.equal(typeof sidebar.component, 'function')
  assert.equal(typeof main.component, 'function')
  assert.equal(localeRegistrations.length, 4)
  assert.deepEqual(localeRegistrations.map((row) => row[1]), ['zh', 'zh-CN', 'en', 'en-US'])

  for (const cleanup of cleanups.reverse()) cleanup()
})

test('装了游戏厅时只向游戏厅登记，不再注册独立槽位', () => {
  const { mod, fakeWindow } = loadModule()
  const calls = []
  fakeWindow.__dshArcade = {
    register(definition) {
      calls.push(definition)
      return () => {}
    },
  }
  const registrations = []
  const cleanups = []
  mod.apply(makeCtx(registrations, [], cleanups))
  assert.equal(registrations.length, 0, '游戏厅在时不注册 sidebar/main')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'dsh-clawd-run')
  assert.equal(calls[0].order, 51)
  assert.equal(typeof calls[0].Panel, 'function')
  assert.equal(typeof calls[0].icon, 'function')
  assert.equal(calls[0].title(), 'nav.label')
  for (const cleanup of cleanups.reverse()) cleanup()
})

function readDict(name) {
  const start = source.indexOf('const ' + name + ' = {')
  assert.ok(start !== -1, '找到 ' + name)
  const end = source.indexOf('\n    }\n', start)
  assert.ok(end > start, '找到 ' + name + ' 结尾')
  const text = source.slice(source.indexOf('{', start), end + 6)
  // eslint-disable-next-line no-new-func
  return new Function('return ' + text)()
}

test('中英文案键一致，且没有空文案', () => {
  const zh = readDict('ZH')
  const en = readDict('EN')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) {
    assert.ok(typeof zh[key] === 'string' && zh[key].length > 0, 'ZH 空文案：' + key)
    assert.ok(typeof en[key] === 'string' && en[key].length > 0, 'EN 空文案：' + key)
  }
})

test('源码里 t()/fmt() 用到的键都有翻译', () => {
  const zh = readDict('ZH')
  const used = new Set()
  for (const pattern of [/\bt\('([^']+)'\)/g, /\bfmt\('([^']+)'/g]) {
    let match = pattern.exec(source)
    while (match) {
      used.add(match[1])
      match = pattern.exec(source)
    }
  }
  assert.ok(used.size > 10)
  for (const key of used) assert.ok(Object.prototype.hasOwnProperty.call(zh, key), '缺翻译：' + key)
})

test('package.json 的 dsh 清单字段齐全', () => {
  assert.equal(pkg.name, 'dsh-plugin-clawd-run')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true)
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
  assert.match(pkg.engines.dsh, />=0\.1\.5/)
  for (const file of ['lib', 'cordis.patch.yml', 'locale', 'icon.svg', 'README.md']) {
    assert.ok(pkg.files.includes(file), 'files 缺 ' + file)
  }
})

test('bundle patch、图标、locale 元数据都在', () => {
  assert.ok(existsSync(join(root, 'icon.svg')))
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*dsh-clawd-run/)
  assert.match(patch, /name:\s*'dsh-plugin-clawd-run'/)
  for (const locale of ['zh', 'en']) {
    const meta = JSON.parse(readFileSync(join(root, 'locale', locale + '.json'), 'utf8'))
    assert.ok(meta.meta && meta.meta.title, locale + ' 缺 title')
    assert.ok(meta.meta.description.length > 20, locale + ' description 太短')
  }
})

test('CSS 都带 cr- 前缀，存档键带 dshclawd 前缀，内核标记存在', () => {
  const start = source.indexOf('const CSS = [')
  const end = source.indexOf("].join('\\n')", start)
  assert.ok(start !== -1 && end > start, '找到 CSS')
  const block = source.slice(start, end)
  const rules = (block.match(/'[^']*'/g) || []).map((row) => row.slice(1, -1))
  assert.ok(rules.length > 15, 'CSS 规则数量 ' + rules.length)
  let selectors = 0
  for (const rule of rules) {
    if (rule[0] !== '.') continue
    selectors += 1
    const first = rule.match(/^\.[a-zA-Z][a-zA-Z0-9_-]*/)
    assert.ok(first, '解析选择器失败：' + rule)
    assert.match(first[0], /^\.cr-/, '未加前缀的选择器：' + first[0])
  }
  assert.ok(selectors > 15)
  const keys = source.match(/dshclawd\.[a-z]+\.v\d+/g) || []
  assert.ok(keys.length >= 3, '至少 3 个存档键')
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(source.indexOf('// ── #region game-core') !== -1)
  assert.ok(source.indexOf('// #endregion game-core') !== -1)
  assert.ok(source.indexOf('function PanelClawdRun') !== -1)
})

console.log('')
console.log('clawd-run shell: ' + passed + ' 项通过')
if (process.exitCode) {
  console.error('有失败项')
} else {
  console.log('全部通过')
}
