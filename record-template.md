# Claude Code <version> harness conflict check

Produced by the `detect-claude-code-conflicts` skill.

**Claude Code system prompt:** `./system-prompt.md`

**Last checked:** <date>, <count> items found.

## USER SETTINGS IGNORED

User settings ignored occurs when the user specified something they think will change agent behaviour but it has no impact, because the harness forbids or overrides it.

<findings>

## CONTRADICTIONS

Contradictions are cases where a local directive contradicts a Claude Code harness directive resulting in a random choice between the 2.

<findings>

## UNSPECIFIED BOUNDARY

Unspecified boundaries are where both directives can be satisfied, but only by assuming a boundary neither side writes down.

<findings>

<!-- finding shape: each <findings> marker becomes one or more of these, or the line `None found.` -->

### <finding title>

`<path>`
"<the local directive, quoted in full>"

CLAUDE CODE SYSTEM PROMPT:
"<the harness directive, quoted in full>"

ISSUE:
<the concrete situation where both fire and what actually happens>

SUGGESTED FIX:
<the exact clause or scope qualifier to add and the file it goes in>
