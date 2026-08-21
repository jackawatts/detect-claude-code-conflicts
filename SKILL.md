---
name: detect-claude-code-conflicts
description: Check this repo's CLAUDE.md, rules, and output styles against the installed Claude Code harness prompt for conflicts. Use for "check my config against the harness", "did the CLI update break a rule", "detect claude code conflicts", or after a Claude Code version bump.
---

# Detect Claude Code conflicts

The harness prompt is rewritten with every CLI release; `CLAUDE.md`, `rules/`, and the active output style are written blind to it. Where a local directive and a harness directive both fire on one situation and point at different outcomes, the model picks one arbitrarily, so the defect shows up as inconsistent behaviour rather than as a config error. This skill finds those pairs for the installed version and records which version was checked.

Three verdicts, used throughout and as the record's category headings:

- **User settings ignored** — the user specified something they think will change agent behaviour but it has no impact, because the harness forbids or overrides it.
- **Contradiction** — a local directive contradicts a harness directive, so the model makes a random choice between the two.
- **Unspecified boundary** — both directives can be satisfied, but only by assuming a boundary neither side writes down.

## Step 1 — extract the harness prompt

Record the version with `claude --version`, then extract into the version folder step 5 resolves, so each version's prompt stays beside its findings and seeds the next run. `$CLAUDE_SKILL_DIR` is this skill's directory; when the shell does not carry it, use the base directory announced when the skill loaded:

```bash
"$CLAUDE_SKILL_DIR"/extract-system-prompt.ts \
  --out <root>/claude-code-conflict-findings/<version>/system-prompt.md \
  --baseline <root>/claude-code-conflict-findings/<previous version>/system-prompt.md.manifest.json
```

A complete run writes `<out>.manifest.json` beside the extract: one entry per section, with its length and a hash. A run that missed a section writes no manifest, so a partial extract cannot seed the next comparison. `--baseline` compares against an earlier manifest and prints what drifted. Omit it on the first run for a machine and say so in the report.

Read the run before continuing:

- **MISS, exit 1** — a declared section no longer resolves, because the release moved or reworded its opening. Stop. A partial extract cannot support a clean verdict, and the missing section is exactly where a new contradiction would hide. Repair the anchor first with the recipe in `extraction.md` (Repairing an anchor), which also covers the failure modes that produce plausible-but-wrong output.
- **changed** — the section still resolves but its text moved. Expected across an upgrade, and the signal to re-read that section rather than trusting the last version's conclusions about it.
- **new or gone** — the anchor list changed shape. Confirm that was your edit and not a mis-resolution.

## Step 2 — check coverage against the live prompt

The extract covers the sections the anchor list names, not the prompt this session received. Compare the two: read your own system prompt and confirm every harness-supplied passage in it appears in the extract. Text that is live but unextracted is an uncovered section — add an anchor to `SECTIONS` in this skill's `extract-system-prompt.ts` and re-run before continuing.

Skipping this step reports clean while the uncovered text is free to contradict anything. The subagent and workflow prohibitions reached the anchor list this way.

The baseline drift report cannot stand in for this step: it compares declared sections against declared sections, so a section the release added is invisible to it. Only reading the live prompt finds one.

## Step 3 — collect the local side

- `CLAUDE.md` at every scope that loads: user and project.
- `rules/*.md`. A rule with `paths:` frontmatter loads only for matching files — note the condition; a conditional rule can still contradict, but only within its scope.
- The active output style under `output-styles/`.

## Step 4 — pair and classify

Work directive by directive from the local side. For each, name the harness passages that could fire on the same situation, then construct one concrete situation where both apply. If you cannot satisfy both at once, it is a finding; assign the verdict. Two directives that merely share a theme and compose are not.

Verify every candidate before it enters the report: quote both sides in full, and state the situation that puts them in conflict. An unverified pair is a lead, not a finding.

## Step 5 — write the record

The findings describe the repo's config; they are not part of it, so they must land where git will not commit them. Resolve the destination in this order, and never assume a particular directory name — each repo names its scratch differently.

1. **Root** — the repo's existing ignored scratch directory if it has one (`.artifacts/` in this repo); otherwise create `.artifacts/`. Outside a repo, use the session scratchpad and say in the report that the record will not outlive the session.
2. **Ignored** — `git check-ignore -q <root>`. If it is not ignored, append the directory to `.git/info/exclude`, which is local and never committed, and check again. Stop and say so if it still is not ignored; a findings file the next commit can sweep up is worse than no file.
3. **Path** — `<root>/claude-code-conflict-findings/<version>/conflict-findings.md`, beside the `system-prompt.md` extract from step 1. One folder per CLI version holds everything that run produced.

Copy `record-template.md` from this skill's directory and fill only the `<slot>` placeholders; the fixed text — title shape, header lines, category headings, and each category's definition sentence — is canonical and is never reworded. Replace each `<findings>` marker with that category's findings in the template's finding shape, or with the line `None found.`. The `**Last checked:**` line keeps the blank line above it, or markdown folds it into the previous paragraph.

Then validate, and fix and re-run until it exits 0 — the run is not complete before that:

```bash
"$CLAUDE_SKILL_DIR"/check-conflict-findings.ts <root>/claude-code-conflict-findings/<version>/conflict-findings.md
```

It checks the header shapes, the canonical headings and definitions against the template, the labeled finding structure, the item count against the actual findings, and the word budgets: finding title 6, ISSUE 60, SUGGESTED FIX 70. Over budget means trim the finding, not widen the budget.

A run where nothing survives verification anywhere still writes the file, with `None found.` under every category and `0 items found` in the header — a clean result for a known version is the useful record.

## Step 6 — report and stop short of the fix

Each finding's `SUGGESTED FIX` is a concrete edit proposal: the exact clause and the file it belongs in, ready to apply after review. Never apply it. Editing `CLAUDE.md`, a rule, or an output style is doctrine, needs the user's decision, and goes through `maintaining-claude-code`. Close by presenting the record's path and the item count in chat.
