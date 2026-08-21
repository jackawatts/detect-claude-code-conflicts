#!/usr/bin/env node
// Skill-helper exit codes: 0 record valid, 1 format findings, 2 cannot run.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = 'usage: check-conflict-findings.ts <conflict-findings.md>'

function splitLines(text: string): string[] {
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''))
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length
}

const TITLE = /^# Claude Code \d+\.\d+\.\d+ harness conflict check$/
const LAST_CHECKED = /^\*\*Last checked:\*\* \d{4}-\d{2}-\d{2}, (\d+) items found\.$/
const PROMPT_LABEL = 'CLAUDE CODE SYSTEM PROMPT:'
const ISSUE_LABEL = 'ISSUE:'
const FIX_LABEL = 'SUGGESTED FIX:'
const NONE_FOUND = 'None found.'
const TITLE_WORDS = 6
const ISSUE_WORDS = 60
const FIX_WORDS = 70

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`)
  process.exit(2)
}

interface Template {
  readonly fixedHeader: readonly string[]
  readonly categories: readonly { heading: string; definition: string }[]
}

function readTemplate(): Template {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'record-template.md')
  let lines: string[]
  try {
    lines = splitLines(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const categories: { heading: string; definition: string }[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('## ')) categories.push({ heading: line, definition: lines[index + 2] ?? '' })
  }
  if (categories.length === 0) fail(`no category headings in ${path}`)
  return { fixedHeader: lines.slice(1, 7), categories }
}

const problems: string[] = []

function report(line: number, message: string): void {
  problems.push(`${file}:${line} — ${message}`)
}

function overBudget(label: string, limit: number, text: string, line: number): void {
  const words = countWords(text)
  if (words > limit) report(line, `${label} has ${words} words (maximum ${limit})`)
}

const file = process.argv[2]
if (file === undefined || file === '' || process.argv.length > 3) fail('expected exactly one record path')

let lines: string[]
try {
  lines = splitLines(readFileSync(file, 'utf8'))
} catch (error) {
  fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
}

const template = readTemplate()

if (!TITLE.test(lines[0] ?? '')) report(1, 'title must be "# Claude Code <version> harness conflict check"')
template.fixedHeader.slice(0, -1).forEach((expected, offset) => {
  const at = 1 + offset
  if ((lines[at] ?? '') !== expected) {
    report(at + 1, `header line must read exactly: ${expected === '' ? '(blank line)' : expected}`)
  }
})
const lastChecked = LAST_CHECKED.exec(lines[6] ?? '')
if (lastChecked === null) {
  report(7, 'line 7 must read "**Last checked:** <YYYY-MM-DD>, <N> items found." on its own paragraph')
}

const headingLines = lines.map((line, index) => ({ line, index })).filter((entry) => entry.line.startsWith('## '))
if (headingLines.map((entry) => entry.line).join('\n') !== template.categories.map((category) => category.heading).join('\n')) {
  report(1, `record must hold exactly these headings in order: ${template.categories.map((category) => category.heading.slice(3)).join(', ')}`)
}

let findingCount = 0

for (const [categoryIndex, entry] of headingLines.entries()) {
  const expected = template.categories[categoryIndex]
  if (expected === undefined || entry.line !== expected.heading) continue
  const end = headingLines[categoryIndex + 1]?.index ?? lines.length
  const definition = lines[entry.index + 2] ?? ''
  if (definition !== expected.definition) {
    report(entry.index + 3, `definition under ${entry.line.slice(3)} must read exactly: ${expected.definition}`)
  }

  const body = lines.slice(entry.index + 3, end)
  const bodyStart = entry.index + 3
  const findingStarts = body.map((line, index) => ({ line, index })).filter((item) => item.line.startsWith('### '))
  if (findingStarts.length === 0) {
    const content = body.filter((line) => line.trim() !== '')
    if (content.length !== 1 || content[0] !== NONE_FOUND) {
      report(entry.index + 1, `a category with no findings holds exactly one line: ${NONE_FOUND}`)
    }
    continue
  }
  const preamble = body.slice(0, findingStarts[0]?.index ?? 0).filter((line) => line.trim() !== '')
  if (preamble.length > 0) {
    report(bodyStart + 1, 'nothing belongs between the definition and the first finding')
  }

  for (const [findingIndex, start] of findingStarts.entries()) {
    findingCount += 1
    const findingEnd = findingStarts[findingIndex + 1]?.index ?? body.length
    const finding = body.slice(start.index, findingEnd)
    const findingLine = bodyStart + start.index + 1
    overBudget('finding title', TITLE_WORDS, start.line.slice(4), findingLine)

    const labelAt = (label: string): number => finding.findIndex((line) => line === label)
    const prompt = labelAt(PROMPT_LABEL)
    const issue = labelAt(ISSUE_LABEL)
    const fix = labelAt(FIX_LABEL)
    if (prompt === -1 || issue === -1 || fix === -1 || !(prompt < issue && issue < fix)) {
      report(findingLine, `finding must hold ${PROMPT_LABEL} then ${ISSUE_LABEL} then ${FIX_LABEL}, each alone on its line`)
      continue
    }
    const source = finding.slice(1, prompt).filter((line) => line.trim() !== '')
    if (source.length < 2 || !(source.at(-1) ?? '').startsWith('"')) {
      report(findingLine + 1, 'finding opens with the source line, then the quoted directive')
    }
    const evidence = finding.slice(prompt + 1, issue).filter((line) => line.trim() !== '')
    if (evidence.length === 0 || !(evidence[0] ?? '').startsWith('"')) {
      report(findingLine + prompt + 1, `${PROMPT_LABEL} must be followed by the quoted harness directive`)
    }
    overBudget(ISSUE_LABEL.slice(0, -1), ISSUE_WORDS, finding.slice(issue + 1, fix).join('\n'), findingLine + issue)
    overBudget(FIX_LABEL.slice(0, -1), FIX_WORDS, finding.slice(fix + 1).join('\n'), findingLine + fix)
  }
}

if (lastChecked !== null && Number(lastChecked[1]) !== findingCount) {
  report(7, `header says ${lastChecked[1]} items found but the record holds ${findingCount}`)
}

if (problems.length > 0) {
  process.stdout.write(`${problems.join('\n')}\n`)
  process.exit(1)
}
process.exit(0)
