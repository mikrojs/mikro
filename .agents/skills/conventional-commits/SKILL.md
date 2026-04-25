---
name: conventional-commits
description: Write commit messages in conventional-commits format (`type(scope): subject`) with a short subject that surfaces the *why* behind the change. Apply BEFORE invoking `git commit`, `git commit --amend`, `gh pr create`, or any other command that takes a commit-shaped message — including squash/merge messages and PR titles. Triggers on user phrases like "commit", "commit this", "make a commit", "create a PR", "open a PR", "push and PR", "amend", "squash", or any time you are about to generate a string that will land in `git log`. Apply even for trivial-seeming commits — consistency in the log is the whole point — and ALWAYS include a scope.
---

# Conventional Commits

Write commit messages in the [conventional-commits](https://www.conventionalcommits.org/en/v1.0.0/#specification) format. Keep them short. Lead with the _why_ whenever the _what_ alone wouldn't tell a future reader anything they couldn't already see in the diff.

## Format

```
<type>(<scope>): <subject>

<body>     // optional, only if the why doesn't fit in the subject
<footer>   // optional: BREAKING CHANGE, Refs, Co-Authored-By, etc.
```

## Types

- `feat`: new user-facing capability
- `fix`: bug fix
- `perf`: performance improvement
- `refactor`: internal change with no behavior diff
- `docs`: docs only
- `test`: tests only
- `build`: build system, deps, packaging
- `ci`: CI config
- `chore`: tooling, repo hygiene, version bumps, anything not above
- `revert`: reverts a prior commit
- `style`: pure formatting (rare; usually folded into `chore`)

Tie-breaker for `feat` vs `chore`: would a user plausibly notice this in a release note? Yes is `feat`. No is `chore` or `refactor`.

## Scope

**Always include a scope.** The scope names the area touched and is what makes the log scannable.

- For monorepos, prefer the package or top-level dir (e.g. `native`, `firmware`, `quickjs`, `cli`, `wifi`, `kv`, `gpio`, `pwm`, `repl`, `docs`, `deps`).
- Before inventing a scope, run `git log --oneline -50` and reuse one that already exists for that area.
- If the change touches several areas, pick the dominant one rather than dropping the scope. Truly cross-cutting commits (e.g. repo-wide tooling that fits no single area) are the rare exception — and even then, prefer a coarse scope like `repo` or `workspace` over no scope.

Common scopes for tooling/hygiene work that often gets left bare:

- `deps` — dependency bumps
- `repo` / `workspace` — root-level config, monorepo plumbing
- `ci` (as a scope under `chore:`, or use `ci:` as the type)
- `gitignore`, `editor`, `tsconfig` — when truly that narrow

If you find yourself writing `chore:` or `feat:` with no scope, stop and pick one.

## Subject line

- Imperative mood ("add", not "added" / "adds")
- Lowercase first word
- No trailing period
- Target 50 chars, hard cap 72
- Specific enough that someone scanning `git log --oneline` understands what changed and roughly why

## Why over what

The diff already shows _what_ changed. The subject earns its keep when it explains _why_ the change is justified. Some flex is fine: when the _what_ is genuinely the clearest summary, don't twist the wording to manufacture a why.

Less useful (restates the diff):

- `fix(wifi): retry reconnection`
- `refactor: rename foo to bar`
- `feat(kv): add second arg to set()`

More useful (the motivation is implicit in the phrasing):

- `fix(wifi): prevent reconnect storm under brownout`
- `refactor: rename foo to bar to match spec terminology`
- `feat(kv): let callers override the default ttl`

If you can't articulate a _why_ beyond "I changed it", that's a signal the commit may want to be squashed into a neighbour, dropped, or split.

## Body (use sparingly)

Add a body only when the _why_ won't fit on the subject line, or when there's context a future debugger will thank you for: a non-obvious tradeoff, a workaround, a measured perf delta, a related incident or ticket. Don't paraphrase the diff. Don't list files touched.

Wrap the body at 72 chars. Separate it from the subject with one blank line.

## Breaking changes

Either append `!` to the type/scope:

```
feat(kv)!: replace get() callback with promise return
```

or use a footer:

```
feat(kv): replace get() callback with promise return

BREAKING CHANGE: get() now returns a Promise; existing callback-style
callers must await the result.
```

Use the footer form when consumers need migration guidance.

## Reverts

```
revert: feat(kv): replace get() callback with promise return

This reverts commit <hash>.
```

## Examples drawn from real history

```
feat(docs): set up cloudflare/wrangler for preview deploys
build(esp32): narrow eslint ignore pattern so editor lint stays useful
chore(deps): upgrade quickjs to 10.0.1 for spec-aligned import attributes
chore(repo): rewrite as pnpm monorepo with @mikrojs/native runtime
```

## Common mistakes to avoid

- Wrong type (`chore: fix race condition` should be `fix:`)
- Missing scope when one exists in the log for that area
- Subject narrates the diff verbatim instead of the motivation
- Body that paraphrases the diff with no new information
- Capitalized first word, trailing period, past tense
- Several unrelated changes squashed under one type and subject
