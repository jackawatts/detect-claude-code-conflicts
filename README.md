# detect-claude-code-conflicts

A [Claude Code](https://code.claude.com/docs) skill that checks your CLAUDE.md, rules, and output styles against the harness system prompt baked into the installed CLI, and reports where they conflict.

The harness prompt is rewritten with every CLI release, and your local config is written blind to it. Where a local directive and a harness directive both fire on one situation and point at different outcomes, the model picks one arbitrarily — the defect shows up as inconsistent behaviour, not as a config error. This skill finds those pairs for the installed version and records which version was checked, so a version bump tells you exactly what to re-check.

Findings land in one of three categories:

- **User settings ignored** — you wrote a rule you think changes behaviour, but the harness forbids or overrides it, so it is dead text.
- **Contradiction** — a local directive contradicts a harness directive, so the model makes a random choice between the two.
- **Unspecified boundary** — both can be satisfied, but only by assuming a boundary neither side writes down.

Every finding quotes both sides in full, states the concrete situation where they collide, and proposes the exact clause that resolves it. The skill never edits your config; fixes are proposals for you to review.

## Requirements

- Claude Code installed. The skill reads the harness prompt out of the CLI binary, because it is never written to disk; `extraction.md` explains why and how.
- Node.js 24 or newer on `PATH`. The two scripts are TypeScript run directly via Node's type stripping.
- macOS or Linux. On Windows the binary resolution handles `.exe`/`.cmd`, but extraction is untested there.

## Install

As a plugin, with versioned updates:

```
/plugin marketplace add jackawatts/detect-claude-code-conflicts
/plugin install detect-claude-code-conflicts@detect-claude-code-conflicts
```

Or as a plain skill directory:

```bash
git clone https://github.com/jackawatts/detect-claude-code-conflicts ~/.claude/skills/detect-claude-code-conflicts
```

Either way the skill is invoked the same; pick one route, not both.

## Use

In any repo whose Claude Code config you want checked:

```
/detect-claude-code-conflicts
```

Claude extracts the prompt for the installed CLI version, checks its own live prompt for sections the extraction does not yet cover, pairs every local directive against the harness text, and writes the record to a git-ignored scratch folder:

```
<scratch>/claude-code-conflict-findings/<version>/
  conflict-findings.md            # the findings record
  system-prompt.md                # the extracted harness prompt
  system-prompt.md.manifest.json  # per-section hashes; seeds the next version's drift report
```

A clean run still writes the record, with every category reading `None found.`, because a clean result for a known version is the useful record. Re-run after a CLI update; the manifest comparison reports which prompt sections actually changed.

## What is in this repo

| File | Role |
| --- | --- |
| `SKILL.md` | The skill: six steps from extraction to report |
| `extract-system-prompt.ts` | Pulls the prompt sections out of the CLI binary by anchor text; writes the manifest and drift report |
| `check-conflict-findings.ts` | Validates a findings record: canonical headings and definitions, labeled structure, item count, word budgets |
| `record-template.md` | The canonical record shape; fixed text is copied, never composed |
| `extraction.md` | How extraction works, its failure modes, and what the output cannot tell you |

The record format is deliberately rigid: the template holds every fixed sentence, and the validator rejects a record that rewords a definition, exceeds a word budget (finding title 6, ISSUE 60, SUGGESTED FIX 70), or miscounts its own findings. Terseness and consistency are enforced, not requested.

## Caveats

- Anchors track the prompt text of recent CLI versions. A release that rewords a section's opening makes that section report `MISS`, and the run stops rather than producing a partial verdict; repairing the anchor is a one-line edit in `extract-system-prompt.ts`.
- The extracted prompt keeps unresolved `${...}` slots for values that exist only at runtime.
- The binary holds mutually exclusive prompt variants (focus mode, autonomous mode, background agents). The skill compares against the sections a session actually receives and grows the anchor list when it finds live text uncovered.
