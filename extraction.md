# How the extraction works

Read this when this skill's `extract-system-prompt.ts` misses a section, when adding an anchor, or when judging whether an extract can be trusted. Loaded on demand by `SKILL.md`.

## Why it reads the binary

The assembled system prompt is never written to disk. Two cheaper sources were checked first:

- The session transcript at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` stores the conversation only. Grepping it for prompt text hits the assistant quoting the prompt back, not the prompt itself.
- No file under `~/.claude/` or this repo holds the harness-supplied sections, which is why searching the config for something like the scratchpad instruction finds nothing.

The CLI is a Bun-compiled Mach-O binary (~302 MB for 2.1.237) with the minified JavaScript embedded, and the prompt strings sit in it verbatim. Reading them is the only way to get exact wording.

## Usage

```bash
"$CLAUDE_SKILL_DIR"/extract-system-prompt.ts --out prompt.md
"$CLAUDE_SKILL_DIR"/extract-system-prompt.ts --binary ~/.local/share/claude/versions/2.1.237 --out prompt.md
```

`--binary` is optional; without it the script walks `PATH` for `claude` and resolves it through `realpathSync`, which lands on the versioned binary. `--out` defaults to `claude-code-system-prompt-extracted.md` in the working directory.

Extracted text goes to the output file and a per-section report goes to stderr, so the two can be redirected separately. Exit `0` means every section resolved, `1` that one or more missed, `2` that the run could not happen at all.

```
binary   /Users/jack/.local/share/claude/versions/2.1.237
size     317110288 bytes
sections 23/23 resolved
  emit   identity               @ 280552425  57 chars
  emit   output-style-preamble  @ 293104026  141 chars
  emit   security               @ 293080378  459 chars
  emit   harness                @ 293104013  777 chars
  emit   harness-reminders      @ 293117024  154 chars
```

## Drift between releases

A complete run writes `<out>.manifest.json` beside the extract: the binary it read, and one entry per resolved section with its character count and a hash. A run that missed a section writes the extract but no manifest, so a partial run cannot become a baseline the next comparison trusts. Passing an earlier version's manifest as `--baseline` compares the two:

```
wrote    v236.md (8916 bytes) and v236.md.manifest.json
baseline 23 unchanged, 0 drifted
```

That run is 2.1.236 measured against 2.1.237. The hash covers the prose skeleton, not the raw text: every `${...}` slot is replaced by an empty one before hashing, because minified identifiers churn on every release. Without that, the same comparison reported three `changed` sections whose only difference was `${LTl}` becoming `${WTl}`, `bFm` becoming `IFm`, and `_u` becoming `bu` — noise that would teach a reader to ignore the report.

Drift is not a verdict and does not change the exit code. `changed` marks a section whose wording really moved, so last version's conclusions about it need re-reading. `new` and `gone` should appear only when the anchor list itself changed. A section the release *added* cannot appear here at all, since both sides of the comparison are declared sections; that gap is why the skill reads the live prompt separately.

## Resolution

`SECTIONS` declares a name and an anchor string per prompt section. For each anchor the script:

1. finds every byte offset where the anchor occurs, trying both the raw form and the `\n`-escaped form, since template literals hold real newlines while double-quoted strings hold escape sequences;
2. walks backwards from each hit collecting candidate opening quotes;
3. parses forward from each candidate to find the true end of that literal;
4. keeps candidates whose span contains the full anchor and decodes to at least 98% printable characters, then takes the shortest;
5. unescapes the result and deduplicates by start offset, because several sections share one literal.

No byte offsets are hardcoded. Offsets shift with every release, so a section that stops resolving prints `MISS` and fails the run rather than quietly vanishing from the output.

## Four failure modes worth remembering

Each produced plausible-looking but wrong output, which is the dangerous kind. Anyone extending the section list will hit them again.

- **First match is often not the code.** `indexOf` located the identity string at offset 73.7M, inside a symbol table rather than the JS blob, where it decodes to binary noise. Fixed by scanning all occurrences and rejecting candidates below the printable-character threshold.
- **`${...}` slots can contain backticks.** A template literal interpolating `.join(\`\n\`)` breaks naive backtick matching, because the first backtick found belongs to the nested literal. This truncated `# Harness` mid-bullet and cut the scratchpad block off at "Any file that would otherwise go to ". Fixed with a scanner that tracks interpolation depth and recurses through nested literals.
- **Apostrophes in prose look like string delimiters.** "don't" opened a spurious single-quoted span, which returned `# Corrections` at 255 characters instead of 1245. Fixed by requiring the span to contain the complete anchor. That guard is not enough on its own: two apostrophes far enough apart bound a span that does contain the whole anchor, which is how the autonomous-mode block once emitted twice as mid-sentence fragments starting at "' will block the work". Fixed with `canCloseLiteral`, the closing-side twin of `canOpenLiteral` — code punctuation follows a real closing quote, prose follows an apostrophe.
- **A closing quote is not an opening quote.** Scanning backwards from `# Harness` found the terminating quote of the preceding string and treated it as an opening delimiter, yielding a bogus 265-character span that passed every other check. Fixed with `canOpenLiteral`, which requires the preceding non-whitespace character to be punctuation or the end of a keyword such as `return`.

In the config repo this skill ships from, `tests/scripts/extract-system-prompt.test.ts` holds the regressions: the printable-ratio and nested-interpolation cases, the manifest, and the baseline comparison. Its fixture is built from the declared anchors, so an anchor that cannot resolve fails CI.

Anchor length is the defence against a mis-resolution. A short anchor can start matching a different literal after a release rewords its neighbourhood, and that failure prints `emit` rather than `MISS`. Prefer an anchor long enough to be unique to its section, and check the drift report's character counts when one is necessarily short.

## Repairing an anchor

Follow this when a section reports `MISS`, or step 2 finds live prompt text with no anchor. Every repair is an edit to `SECTIONS` in `extract-system-prompt.ts`; nothing else changes.

1. **Find the surviving wording.** For a MISS, locate the section in the live prompt or the previous version's extract, then grep the binary for phrases from it, longest first: `grep -ac "<phrase>" <binary>`. Zero hits for every phrase means the section was removed or repackaged, not reworded — stop and report rather than forcing an anchor.
2. **Check the occurrence count.** Most phrases occur 2-8 times (code, source maps, sibling variants). That is fine; resolution filters candidates. What matters is uniqueness to the *section*: a phrase that also opens a different section or a variant of this one will resolve the wrong literal.
3. **Prefer the section's heading or opening sentence.** A `# Heading` anchor resolves the literal from its start and captures the whole section. A mid-section phrase resolves whatever smallest literal contains it, which is how a sentence-level anchor once matched a sibling variant (`# Text output`) instead of the live section.
4. **Re-run and read three signals.** The section must `emit` (or `dup` into a section it genuinely shares a literal with); its character count must be plausible against the live text, not a fragment; and the `--baseline` drift report must show only the sections you expect to change.
5. **Confirm coverage.** Diff the extract against the live prompt one more time (step 2 of the skill). A repair that resolves cleanly can still be the wrong span — the count and the content are the check, not the exit code.

## What the output cannot tell you

- **Interpolations stay unresolved.** The output keeps `${WTl}`, `${e}` for the scratchpad path, the model-roster `.map()` expression, and the `${Ri}`/`${Ls}`/`${Hl}`/`${bu}` tool-name slots. Those values exist only at runtime, and filling them in would substitute one session's values for what the binary holds.
- **Section order is asserted, not derived.** Runtime assembly order comes from a builder the script does not parse, so the emitted sequence is a reasonable reading rather than ground truth.
- **Only the listed sections come out.** The binary also holds variants a given session may not receive — focus mode, autonomous mode, the long-form tone and action-safety blocks, git-stash safety, background-agent rules. A raw strings dump would be larger than any real prompt and self-contradictory, since these variants are mutually exclusive. Add anchors deliberately, and compare the extract against the live prompt before trusting its coverage.
- **The output style is not in the binary.** `# Output Style: <name>` wraps the body of `~/.claude/output-styles/<name>.md`, a local file that needs no extraction.
