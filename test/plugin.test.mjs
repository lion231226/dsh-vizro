import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/host/index.js'
import { loadSkills, parseFrontmatter } from '../lib/host/skills.js'
import { findApps } from '../lib/host/routes.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function makeCtx() {
  const tools = []
  const disposers = []
  const ctx = {
    logger: { debug() {} },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    },
    get(service) {
      if (service === 'tools') return { register: (tool) => ({ dispose: () => {} }) }
      if (service === 'skills') return { register: () => () => {} }
      if (service === 'webServer') return { register: () => () => {} }
      return undefined
    },
  }
  return { ctx, tools, disposers }
}

test('manifest declares the installable bundle face', async () => {
  const pkg = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(path.join(ROOT, 'package.json'), 'utf8')))
  assert.equal(pkg.name, 'dsh-vizro')
  assert.ok(pkg.dsh.bundle.patch)
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.peerDependencies['@deepseek-ai/cordis'])
  assert.equal(pkg.dependencies?.['@deepseek-ai/dsh-tools'], undefined, 'official packages must stay peer deps')
})

test('plugin exposes name, inject list and an apply function', () => {
  assert.equal(name, 'vizro')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('registering seven tools through a mock registry', () => {
  const { ctx, disposers } = makeCtx()
  const seen = []
  ctx.get = (service) => {
    if (service === 'tools') return { register: (tool) => (seen.push(tool), () => {}) }
    if (service === 'skills') return { register: () => () => {} }
    if (service === 'webServer') return { register: () => () => {} }
    return undefined
  }
  apply(ctx)
  assert.equal(seen.length, 7)
  assert.deepEqual(
    seen.map((tool) => tool.name).sort(),
    ['vizro_data', 'vizro_doctor', 'vizro_probe', 'vizro_run', 'vizro_scaffold', 'vizro_schema', 'vizro_validate'],
  )
  for (const tool of seen) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 60, `${tool.name} needs a real description`)
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.output.schema.constructor, Object)
    assert.equal(typeof tool.execute, 'function')
    const rendered = tool.output.render({}, { ok: true })
    assert.equal(rendered[0].type, 'text')
  }
  assert.equal(disposers.length > 0, true)
})

test('skills parse their frontmatter', () => {
  const skills = loadSkills()
  assert.equal(skills.length, 6)
  for (const skill of skills) {
    assert.match(skill.name, /^vizro-/)
    assert.ok(skill.description.length > 20)
    assert.ok(skill.content.length > 400)
    assert.equal(skill.source, 'runtime')
  }
  const { data, body } = parseFrontmatter('---\nname: x\ndescription: "y: z"\n---\n\nbody\n')
  assert.deepEqual(data, { name: 'x', description: 'y: z' })
  assert.equal(body.trim(), 'body')
})

test('findApps locates Vizro entry files', () => {
  const apps = findApps(ROOT, 2, 10)
  assert.ok(apps.some((app) => app.name.endsWith('.py')))
})


