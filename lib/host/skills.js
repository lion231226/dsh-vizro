/**
 * dsh-vizro — skills.
 *
 * The six skills are plain SKILL.md files shipped inside the package. They are
 * registered into the host registry with `ctx.skills.register`, so they appear
 * in the session skill catalog exactly like project or user skills — no agent
 * preset edit, no file copy into the profile.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SKILLS_DIR = path.resolve(HERE, '..', '..', 'skills')

/** Minimal YAML frontmatter reader: `key: value` lines between --- markers. */
export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: text }
  const header = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

/** Read every skills/<name>/SKILL.md as a registration payload. */
export function loadSkills(dir = SKILLS_DIR) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(dir, entry.name, 'SKILL.md')
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { data, body } = parseFrontmatter(raw)
    const name = data.name || entry.name
    const description = data.description || ''
    if (description === '') continue
    skills.push({
      name,
      description,
      whenToUse: data.when_to_use,
      content: body.trim(),
      source: 'runtime',
      path: path.join(dir, entry.name),
      resourceBase: { kind: 'directory', path: path.join(dir, entry.name) },
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Register every skill into the calling context's layer.
 * @param {object} skillsService - `ctx.skills`
 * @returns {() => void} composite disposer
 */
export function registerSkills(skillsService) {
  const disposers = []
  for (const skill of loadSkills()) {
    try {
      disposers.push(skillsService.register(skill))
    } catch {
      // a duplicate name from another layer must not break plugin loading
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // ignore
      }
    }
  }
}
