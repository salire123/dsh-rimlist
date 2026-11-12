// Bundled skill: reads skills/rimlist/SKILL.md into a ctx.skills.register() definition.
// dsh-skill-filesystem does not scan plugin folders in node_modules, so a SKILL.md inside
// the package is only found when the plugin registers it at runtime. SKILL.md sets
// disable-model-invocation: true, so the skill is user-only: it activates when the user types
// "/rimlist", and the model never loads it on its own.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SKILL_NAME = 'rimlist'
export const SKILL_DIR = join(HERE, '..', '..', 'skills', SKILL_NAME)
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

function field(frontmatter, key) {
  const m = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(frontmatter)
  if (!m) return undefined
  let v = m[1].trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1)
  return v || undefined
}

/** @returns {{name: string, description: string, whenToUse?: string, content: string, source: string, resourceBase: object} | null} */
export function loadSkillDefinition() {
  let raw
  try {
    raw = readFileSync(SKILL_FILE, 'utf8')
  } catch {
    return null
  }
  const m = FRONTMATTER.exec(raw)
  if (!m) return null
  const name = field(m[1], 'name')
  const description = field(m[1], 'description')
  const content = raw.slice(m[0].length).trim()
  if (!name || !description || !content) return null
  // disable-model-invocation: true → hidden from the model's skill catalog and `skill` tool;
  // only the user's "/rimlist" in a message loads it.
  const definition = {
    name,
    description,
    content,
    source: 'runtime',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
    invocation: {
      modelInvocable: !/^(true|yes|on|1)$/i.test(field(m[1], 'disable-model-invocation') || ''),
      userInvocable: !/^(false|no|off|0)$/i.test(field(m[1], 'user-invocable') || ''),
    },
  }
  const whenToUse = field(m[1], 'whenToUse')
  if (whenToUse) definition.whenToUse = whenToUse
  return definition
}
