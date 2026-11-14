import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Minimal React surface: enough to execute the component body without a DOM. */
function stubReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useMemo: (factory) => factory(),
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
}

/** Load the browser half the way the shell does, then drive its registration. */
async function loadClient() {
  const captured = {}
  globalThis.window = { __ModuleLoader__: { load: (descriptor) => (captured.descriptor = descriptor) } }
  await import(pathToFileURL(path.join(ROOT, 'lib', 'client', 'index.js')).href + `?t=${Date.now()}`)
  assert.ok(captured.descriptor, 'client must call window.__ModuleLoader__.load')
  const requireShim = (name) => {
    if (name === 'react') return stubReact()
    if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}) }
    throw new Error(`unexpected client import: ${name}`)
  }
  const module = captured.descriptor.factory(requireShim)
  return { descriptor: captured.descriptor, module, captured }
}

test('client half registers a settings section with a labelled id', async () => {
  const { descriptor, module } = await loadClient()
  assert.equal(descriptor.id, 'dsh-vizro')
  assert.deepEqual(module.inject, ['slots', 'locale'])
  let slot = ''
  let options = {}
  let component = null
  const ctx = {
    effect: (factory) => {
      factory()
      return () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (name, run) => {
        slot = name
        return run()
      },
      register: (opts, comp) => {
        options = opts
        component = comp
        return () => {}
      },
    },
  }
  module.apply(ctx)
  assert.equal(slot, 'settings.section')
  assert.equal(options.id, 'vizro')
  assert.equal(options.label, 'Vizro')
  assert.equal(options.order, 60)
  assert.equal(typeof component, 'function')
})

test('the panel renders its empty state without throwing', async () => {
  const { module } = await loadClient()
  // No DOM, no fetch: the component is driven with the stub hooks only, which
  // still executes every branch that runs before data arrives.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline stub')
  }
  try {
    const tree = module.VizroPanel({ t: (key) => key })
    const text = JSON.stringify(tree)
    assert.match(text, /section\.title/)
    assert.match(text, /apps\.title/)
    assert.doesNotMatch(text, /error/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dictionaries cover the same keys in both languages', async () => {
  const { module } = await loadClient()
  const zhKeys = Object.keys(module.DICTS.zh).sort()
  const enKeys = Object.keys(module.DICTS.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length >= 15)
})

