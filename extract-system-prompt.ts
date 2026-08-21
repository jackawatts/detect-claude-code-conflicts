#!/usr/bin/env node
// Skill-helper exit codes: 0 resolved, 1 missed, 2 cannot run.
import { createHash } from 'node:crypto'
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

const USAGE = 'usage: extract-system-prompt.ts [--binary <path>] [--out <path>] [--baseline <manifest>]'

const BACKTICK = 0x60
const DQUOTE = 0x22
const SQUOTE = 0x27
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
const DOLLAR = 0x24
const MAX_LITERAL = 24_000
const MIN_PRINTABLE = 0.98
const LABEL_WIDTH = 22

interface Section {
  readonly name: string
  readonly anchor: string
}

interface Span {
  readonly start: number
  readonly text: string
}

interface SectionRecord {
  readonly name: string
  readonly chars: number
  readonly sha256: string
}

interface Manifest {
  readonly binary: string
  readonly sections: readonly SectionRecord[]
}

const SECTIONS: readonly Section[] = [
  { name: 'identity', anchor: "You are Claude Code, Anthropic's official CLI for Claude." },
  { name: 'output-style-preamble', anchor: 'You are an interactive agent that helps users according to your' },
  { name: 'security', anchor: 'IMPORTANT: Assist with authorized security testing' },
  { name: 'harness', anchor: '# Harness\n - Text you output outside of tool use' },
  { name: 'harness-reminders', anchor: 'The system may send updates, reminders, or modifications' },
  { name: 'pronouns', anchor: 'When you use a pronoun for someone' },
  { name: 'reversibility', anchor: 'For actions that are hard to reverse or outward-facing' },
  { name: 'environment', anchor: 'You have been invoked in the following environment' },
  { name: 'model-roster', anchor: 'The most recent Claude models are the Claude 5 family' },
  { name: 'availability', anchor: 'Claude Code is available as a CLI in the terminal' },
  { name: 'fast-mode', anchor: 'Fast mode for Claude Code uses Claude Opus' },
  { name: 'scratchpad', anchor: 'IMPORTANT: Always use this scratchpad directory' },
  { name: 'context-management', anchor: '# Context management\nWhen the conversation grows long' },
  { name: 'act-when-ready', anchor: 'When you have enough information to act, act.' },
  { name: 'delivering-work', anchor: '# Delivering work\nDo ordinary work as asked' },
  { name: 'corrections', anchor: '# Corrections\nAvoid unnecessary or excessive self-correction' },
  { name: 'auto-mode', anchor: 'tool wherever it can accomplish the job' },
  { name: 'subagent-restriction', anchor: 'Do not call the AgentTool unless the user requested it' },
  { name: 'workflow-restriction', anchor: 'Do not use workflows or deep-research unless the user requested it' },
  { name: 'code-idiom', anchor: 'Write code that reads like the surrounding code' },
  { name: 'session-guidance', anchor: 'If you need the user to run a shell command themselves' },
  { name: 'skill-invocation', anchor: 'Only use skills listed in the user-invocable skills section' },
  { name: 'end-conversation', anchor: 'use only for sustained user abuse directed at the assistant' },
  { name: 'communicating', anchor: '# Communicating with the user' },
  { name: 'fable-identity', anchor: 'This iteration of Claude is Claude Fable 5' },
  { name: 'autonomous-mode', anchor: 'You are operating autonomously. The user is not watching' },
  { name: 'turn-completion', anchor: 'Before ending your turn, check your last paragraph' },
  { name: 'state-change-check', anchor: 'Before running a command that changes system state' },
  { name: 'assessment-mode', anchor: 'Exception: when the user is describing a problem' },
]

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function skipQuoted(buf: Buffer, start: number, quote: number): number {
  for (let i = start + 1; i < buf.length; i += 1) {
    if (buf[i] === BACKSLASH) i += 1
    else if (buf[i] === quote) return i
  }
  return -1
}

function skipInterpolation(buf: Buffer, start: number): number {
  let depth = 1
  for (let i = start; i < buf.length; i += 1) {
    const c = buf[i]
    if (c === BACKSLASH) i += 1
    else if (c === BACKTICK) i = endOfTemplate(buf, i)
    else if (c === DQUOTE || c === SQUOTE) i = skipQuoted(buf, i, c)
    else if (c === OPEN_BRACE) depth += 1
    else if (c === CLOSE_BRACE && (depth -= 1) === 0) return i
    if (i === -1) return -1
  }
  return -1
}

// A `${...}` slot may itself contain backticks, so nesting must be tracked.
function endOfTemplate(buf: Buffer, start: number): number {
  for (let i = start + 1; i < buf.length; i += 1) {
    const c = buf[i]
    if (c === BACKSLASH) i += 1
    else if (c === BACKTICK) return i
    else if (c === DOLLAR && buf[i + 1] === OPEN_BRACE) {
      i = skipInterpolation(buf, i + 2)
      if (i === -1) return -1
    }
  }
  return -1
}

function unescape(raw: string): string {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_match, escape: string) => {
    if (escape.startsWith('u{')) return String.fromCodePoint(Number.parseInt(escape.slice(2, -1), 16))
    if (escape.startsWith('u') || escape.startsWith('x')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }
    return simple[escape] ?? escape
  })
}

function printableRatio(text: string): number {
  let ok = 0
  for (const character of text) {
    const c = character.codePointAt(0) ?? 0
    if (c === 9 || c === 10 || (c >= 32 && c !== 127)) ok += 1
  }
  return text.length === 0 ? 0 : ok / text.length
}

// Template literals hold real newlines where double-quoted strings hold escapes.
function occurrences(buf: Buffer, anchor: string): number[] {
  const forms = [Buffer.from(anchor), Buffer.from(anchor.replaceAll('\n', '\\n'))]
  const hits = new Set<number>()
  for (const form of forms) {
    let at = buf.indexOf(form)
    while (at !== -1) {
      hits.add(at)
      at = buf.indexOf(form, at + 1)
    }
  }
  return [...hits].sort((a, b) => a - b)
}

const OPENERS = new Set('(,=:[{?!+-*/%&|^~<>;}'.split('').map((character) => character.charCodeAt(0)))
const KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'do', 'else', 'yield', 'await', 'throw', 'void', 'delete'])

// A previous string's closing quote cannot open a literal.
function canOpenLiteral(buf: Buffer, at: number): boolean {
  let i = at - 1
  while (i >= 0 && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x09)) i -= 1
  if (i < 0) return true
  if (OPENERS.has(buf[i] ?? 0)) return true
  const end = i + 1
  while (i >= 0 && /[A-Za-z0-9_$]/.test(String.fromCharCode(buf[i] ?? 0))) i -= 1
  return KEYWORDS.has(buf.subarray(i + 1, end).toString('latin1'))
}

function candidateOpens(buf: Buffer, offset: number): { start: number; quote: number }[] {
  const opens: { start: number; quote: number }[] = []
  const floor = Math.max(0, offset - MAX_LITERAL)
  for (let i = offset; i >= floor; i -= 1) {
    const c = buf[i]
    if (c !== BACKTICK && c !== DQUOTE && c !== SQUOTE) continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && buf[j] === BACKSLASH; j -= 1) slashes += 1
    if (slashes % 2 === 0 && canOpenLiteral(buf, i)) opens.push({ start: i, quote: c })
  }
  return opens
}

function extract(buf: Buffer, anchor: string): Span | null {
  const escaped = anchor.replaceAll('\n', '\\n')
  const spans: Span[] = []
  for (const offset of occurrences(buf, anchor)) {
    for (const { start, quote } of candidateOpens(buf, offset)) {
      const end = quote === BACKTICK ? endOfTemplate(buf, start) : skipQuoted(buf, start, quote)
      if (end === -1 || end <= offset) continue
      const raw = buf.subarray(start + 1, end).toString('utf8')
      if (!raw.includes(anchor) && !raw.includes(escaped)) continue
      const text = unescape(raw)
      if (printableRatio(text) < MIN_PRINTABLE) continue
      spans.push({ start, text })
      break
    }
  }
  spans.sort((a, b) => a.text.length - b.text.length)
  return spans[0] ?? null
}

function windowsAwareNames(command: string): string[] {
  if (process.platform !== 'win32') return [command]
  const extensions = (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((extension) => extension !== '')
  return [command, ...extensions.map((extension) => command + extension.toLowerCase())]
}

function resolveOnPath(command: string): string | undefined {
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    if (directory === '') continue
    for (const name of windowsAwareNames(command)) {
      try {
        accessSync(join(directory, name), constants.X_OK)
        return join(directory, name)
      } catch {
        continue
      }
    }
  }
  return undefined
}

function resolveBinary(explicit: string | undefined): string {
  const found = explicit ?? resolveOnPath('claude')
  if (found === undefined) fail(`claude not on PATH\n${USAGE}`)
  try {
    return realpathSync(found)
  } catch (error) {
    fail(`cannot resolve the CLI binary: ${describe(error)}\n${USAGE}`)
  }
}

function readManifest(path: string): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read baseline ${path}: ${describe(error)}`)
  }
  const sections = (parsed as Partial<Manifest>).sections
  if (!Array.isArray(sections) || sections.some((section) => typeof section?.name !== 'string' || typeof section?.sha256 !== 'string')) {
    fail(`baseline ${path} is not a manifest: expected a sections array of name, chars, sha256`)
  }
  return parsed as Manifest
}

// Minified identifiers churn every release; only the prose is compared.
function promptSkeleton(text: string): string {
  let skeleton = ''
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]
    if (depth === 0 && character === '$' && text[i + 1] === '{') {
      depth = 1
      skeleton += '${}'
      i += 1
    } else if (depth > 0) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
    } else {
      skeleton += character
    }
  }
  return skeleton
}

function driftReport(baseline: Manifest, current: readonly SectionRecord[]): string[] {
  const before = new Map(baseline.sections.map((section) => [section.name, section]))
  const lines: string[] = []
  let unchanged = 0
  for (const section of current) {
    const previous = before.get(section.name)
    before.delete(section.name)
    if (previous === undefined) lines.push(`  new      ${section.name}`)
    else if (previous.sha256 === section.sha256) unchanged += 1
    else lines.push(`  changed  ${section.name.padEnd(LABEL_WIDTH)} ${previous.chars} -> ${section.chars} chars`)
  }
  for (const name of before.keys()) lines.push(`  gone     ${name}`)
  return [`baseline ${unchanged} unchanged, ${lines.length} drifted`, ...lines]
}

let options: { binary?: string | undefined; out?: string | undefined; baseline?: string | undefined }
try {
  options = parseArgs({
    options: { binary: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' } },
    allowPositionals: false,
  }).values
} catch (error) {
  fail(`${describe(error)}\n${USAGE}`)
}

const out = options.out ?? 'claude-code-system-prompt-extracted.md'
const binary = resolveBinary(options.binary)

let buf: Buffer
try {
  buf = readFileSync(binary)
} catch (error) {
  fail(`cannot read ${binary}: ${describe(error)}`)
}

const emitted: string[] = []
const records: SectionRecord[] = []
const report: string[] = []
const missing: string[] = []
const seen = new Map<number, string>()

for (const section of SECTIONS) {
  const hit = extract(buf, section.anchor)
  const label = section.name.padEnd(LABEL_WIDTH)
  if (hit === null) {
    missing.push(section.name)
    report.push(`  MISS   ${label}`)
    continue
  }
  const sha256 = createHash('sha256').update(promptSkeleton(hit.text)).digest('hex')
  records.push({ name: section.name, chars: hit.text.length, sha256 })
  const owner = seen.get(hit.start)
  if (owner !== undefined) {
    report.push(`  dup    ${label} shares literal with ${owner}`)
    continue
  }
  seen.set(hit.start, section.name)
  report.push(`  emit   ${label} @${String(hit.start).padStart(10)}  ${hit.text.length} chars`)
  emitted.push(hit.text)
}

const body = `${emitted.join('\n\n')}\n`
const manifestPath = `${out}.manifest.json`
const manifest: Manifest = { binary, sections: records }
try {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, body)
  // A partial run must not leave a manifest baselines would trust.
  if (missing.length === 0) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  else rmSync(manifestPath, { force: true })
} catch (error) {
  fail(`cannot write ${out}: ${describe(error)}`)
}

process.stderr.write(`binary   ${binary}\nsize     ${buf.length} bytes\n`)
process.stderr.write(`sections ${SECTIONS.length - missing.length}/${SECTIONS.length} resolved\n`)
process.stderr.write(`${report.join('\n')}\n`)
process.stderr.write(`wrote    ${out} (${body.length} bytes)${missing.length === 0 ? ` and ${manifestPath}` : ''}\n`)

if (options.baseline !== undefined) {
  process.stderr.write(`${driftReport(readManifest(options.baseline), records).join('\n')}\n`)
}

if (missing.length > 0) {
  process.stderr.write(`missing  ${missing.join(', ')}\n`)
  process.exit(1)
}
