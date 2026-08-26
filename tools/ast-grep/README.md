# Ast-Grep Examples

Ast-grep is useful here for small, syntax-preserving migrations where every
match has the same meaning. Keep rules narrow, run them against named files or
small globs, and inspect the proposed diff before applying anything.

Agents should update this document liberally as they use ast-grep. Add useful
commands, representative examples, and gotchas whenever a rule succeeds,
fails, or needs a narrower scope. This document is the shared working record
for making future transformations safer and more effective.

## Dry Runs

`ast-grep scan` prints proposed replacements by default. Do not pass
`--update-all` when exploring a rule.

Run the existing Effect wrapper rule against one file:

```bash
ast-grep scan \
  --rule tools/ast-grep/effect-run-promise-to-yield.yml \
  src/effect/SessionRegistry.test.ts \
  --report-style medium
```

Run it against a selected group of files:

```bash
ast-grep scan \
  --rule tools/ast-grep/effect-run-promise-to-yield.yml \
  src/effect/SessionRegistry.test.ts \
  src/effect/AttachHub.test.ts
```

Limit a directory with a glob and only print matching paths:

```bash
ast-grep scan \
  --rule tools/ast-grep/effect-run-promise-to-yield.yml \
  src \
  --globs '**/effect/*.test.ts' \
  --files-with-matches
```

The rewrite preview is also available with `ast-grep run`. Omitting
`--update-all` keeps this as a dry run:

```bash
ast-grep run \
  --lang ts \
  --pattern 'import { $$$NAMES } from "bun:test"' \
  --rewrite 'import { $$$NAMES } from "vitest"' \
  src/effect/SessionRegistry.test.ts
```

## Safe Import Rewrite

The whole import declaration is a valid AST pattern, so this is suitable for
the mechanical part of the Bun-to-Vitest migration:

```yaml
id: bun-test-to-vitest
language: TypeScript
rule:
  pattern: import $$$CLAUSE from "bun:test"
fix: import $$$CLAUSE from "vitest"
```

The named-import form can be tested inline:

```bash
ast-grep run \
  --lang ts \
  --pattern 'import { $$$NAMES } from "bun:test"' \
  --rewrite 'import { $$$NAMES } from "vitest"' \
  src/ui/state.test.ts
```

Do not use `from "bun:test"` as the pattern. It is a source fragment made of
multiple AST nodes, not one replaceable node, and ast-grep rejects it.

## Diagnostic-Only Rules

Use a rule without `fix` when the match needs semantic review. This finds
`Effect.runSync` calls in tests without proposing an unsafe replacement:

```bash
ast-grep scan --inline-rules $'\
id: sync-effect-in-test\n\
language: TypeScript\n\
severity: hint\n\
message: Effect.runSync in a test requires manual Effect test conversion\n\
rule:\n\
  pattern: Effect.runSync($E)' \
  src/ui/frame.test.tsx src/ui/state.test.ts \
  --report-style medium
```

This finds legacy daemon starts in tests, if any remain:

```bash
ast-grep scan --inline-rules $'\
id: legacy-daemon-start\n\
language: TypeScript\n\
severity: hint\n\
message: Inspect legacy daemon start call\n\
rule:\n\
  pattern: $DAEMON.start()' \
  src --globs '**/*.test.ts' \
  --report-style medium
```

Diagnostic rules are preferable for `Effect.runSync`, daemon lifecycle calls,
and Promise conversions. The correct replacement depends on whether the
surrounding function must become `it.effect`, `it.scoped`, or remain a normal
Vitest test.

## Effect Channel Checks

`no-unknown-effect-channels.yml` reports `any` or `unknown` in the error or
requirements channels of qualified Effect data types. It covers `Effect`,
`Stream`, `Fiber`, `Deferred`, `FiberMap`, and `Cause`. It intentionally has no
automatic fix: the appropriate replacement is usually `never`, a domain error,
or a generic parameter, depending on the declaration.

Generic helpers should expose an `E` parameter instead of prescribing `any` or
`unknown`; public APIs should use a schema-typed tagged error or a concrete
error union.

Run it against the source tree with:

```bash
ast-grep scan \
  --rule tools/ast-grep/no-unknown-effect-channels.yml \
  src \
  --globs '**/*.ts' \
  --globs '**/*.tsx' \
  --report-style medium
```

The channel fixture contains concrete, generic, `never`, `any`, and `unknown`
examples. Scan it directly when changing the rule:

```bash
ast-grep scan \
  --rule tools/ast-grep/no-unknown-effect-channels.yml \
  tools/ast-grep/tests/no-unknown-effect-channels.ts \
  --report-style medium
```

The rule is deliberately structural. An inference helper that genuinely needs
an unconstrained channel should be reviewed at the call site rather than
excluded by a broad helper-name exception.

## Tagged-Union Branch Checks

`prefer-match-for-tag-check.yml` warns on a direct block or single-statement
`if` whose condition is `$value._tag === $tag`. It intentionally does not
match compound conditions, ternaries, collection predicates, or user-defined
type predicates: those often have a different control-flow shape and need
manual review.

Use `Match.value(value).pipe(Match.tag(tag, handler), Match.orElse(fallback))`
when handling one or a few selected cases. Use `Match.valueTags(value, fields)`
when the operation is naturally a direct tag-to-handler map. For a reusable
matcher, start with `Match.type<Union>()` and use `Match.tags(fields)` plus
`Match.exhaustive`; use `Match.tagsExhaustive(fields)` when the object map
itself should be the exhaustive matcher. `Match.tagStartsWith` is useful for
namespaced tags that share a prefix.

Dry-run it against the source tree with:

```bash
ast-grep scan \
  --rule tools/ast-grep/prefer-match-for-tag-check.yml \
  src \
  --globs '**/*.ts' \
  --report-style medium
```

This is a warning rule rather than a rewrite because choosing `orElse`,
`exhaustive`, or an explicit fallback depends on the surrounding control flow.

## Applying A Reviewed Rule

Only after reviewing the dry-run output should a rule be applied:

```bash
ast-grep scan \
  --rule tools/ast-grep/bun-test-to-vitest.yml \
  src/effect/SessionRegistry.test.ts \
  --update-all
```

Keep the scope narrow, then run formatting, typecheck, and the affected tests.

The installed ast-grep CLI accepts `--lang` on `ast-grep run`, but not on
`ast-grep scan` in this environment; use `ast-grep run` for a syntax rewrite
and inspect its preview before adding `--update-all`.

## State Constant Rewrite

For a repeated property comparison, bind the receiver as a metavariable and
preview the exact AST rewrite before applying it:

```bash
ast-grep run --lang ts \
  --pattern '$OBJ.state === "blocked"' \
  --rewrite '$OBJ.state === AgentState.Blocked' \
  src --globs '**/*.ts' --globs '**/*.tsx' \
  --globs '!**/*.test.ts' --globs '!**/*.test.tsx'
```

The pattern matches the whole comparison, so it does not change unrelated
strings such as turn outcomes or comments. The replacement assumes the target
file already imports `AgentState`; add that import separately when required.

## Nullable-Field Migration

When a field becomes nullable (e.g. `Pane.session` is now `SessionHandle |
null`), the caller sites in tests can be migrated with two narrow rules:

```yaml
id: session-nullassert
language: TypeScript
rule:
  pattern: $PANE.session.$FIELD
fix: $PANE.session!.$FIELD
```

```yaml
id: session-const-nullassert
language: TypeScript
rule:
  pattern: const $NAME = $PANE.session;
fix: const $NAME = $PANE.session!;
```

The member-access rule handled ~60 call sites; the const-declaration rule
handled the rest (`const agent = pane.session;` → `... session!;`), which in
turn fixed the follow-on argument errors at those sites.

Gotchas learned on this migration:

- **`language: TypeScript` does not parse `.tsx`.** The member-access rule
  silently skipped `src/component-pane.test.tsx`; only the one remaining error
  there after the run revealed it. Fix those files by hand, or write the rule
  against TSX.
- The member-access pattern `$PANE.session.$FIELD` only fires when a field
  follows `.session`, so `content.session` (a `string` on a pane-content
  object) was never touched — but a bare `x.session` in a comparison or a Set
  literal is NOT matched and needs a separate pass (or manual edits).
- Run `bunx tsc --noEmit` between passes; the remaining errors tell you exactly
  which shapes the rules missed.
- These are one-off migrations: delete the rule files after the rewrite lands,
  keeping only the documentation of what worked.
