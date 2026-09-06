# Contributing to Grasp

Thanks for helping make AI-assisted coding easier to understand. Bug reports,
documentation improvements, focused feature proposals, and pull requests are
all welcome.

Grasp is early-alpha software. Please discuss large behavioral changes in an
issue before investing heavily in an implementation.

## Development setup

You need Node.js 22.13.0 or newer and Git.

```bash
git clone https://github.com/sanjeevexe/grasp.git
cd grasp
npm ci
npm run build
```

Useful commands:

```bash
npm test                 # automated tests
npm run test:coverage    # tests plus enforced coverage thresholds
npm run lint             # ESLint
npm run format:check     # verify formatting
npm run format           # apply Prettier formatting
npm run dev -- --help    # run the CLI from TypeScript
```

Before opening a pull request, run:

```bash
npm run lint && npm run format:check && npm run build && npm run test:coverage
```

Tests must not contact a real model provider or touch your real `~/.grasp`
directory. Provider calls are mocked, and `test/setup.ts` redirects user data to
temporary directories.

## Architecture at a glance

- `src/cli/` wires commands and translates outcomes into exit codes.
- `src/daemon/` manages one background process and one watcher per project.
- `src/capture/` snapshots and filters filesystem changes.
- `src/generation/` assembles prompts, calls the selected provider, and validates
  structured results.
- `src/storage/` owns the SQLite schema and persistence helpers.
- `src/review/`, `src/mastery/`, and `src/synthesis/` implement the learning loop.
- `src/gate/` manages the optional pre-commit gate.

The detailed rationale and behavioral contract live in
[DESIGN_BRIEF.md](DESIGN_BRIEF.md). Treat it as design context: if your change
intentionally alters a documented behavior, update the brief and user-facing
documentation in the same pull request.

## Product constraints

Keep these invariants intact unless a proposal explicitly changes the product:

- Grasp never grades a user's free-form answer; progression is self-reported.
- Capture remains tool-agnostic and filesystem-based.
- Review reminders are not scheduled or nagging.
- Failed or deferred generation must not advance the source snapshot.
- Source, diffs, and API keys must never appear in logs.
- Shell commands use `execFile` with argument arrays, not interpolated shell
  strings.
- Modules remain importable without starting services or opening databases.

## Testing expectations

The coverage gate requires 85% line and 80% branch coverage overall, with a 95%
line threshold for state-sensitive and cost-sensitive modules. Add regression
tests for bug fixes and exercise real Git/filesystem behavior when that boundary
is the thing being changed.

Some release checks cannot be meaningfully automated. Changes to lifecycle,
watching, notifications, prompts, or hooks may also require manual validation:

- global installation and `grasp init` in a disposable repository;
- service start and reboot survival on the affected operating system;
- question quality on representative diffs;
- `grasp scan` behavior on a larger codebase;
- confirmation that logs contain no source, diffs, or credentials;
- commit-gate behavior against actually staged files.

Describe any manual checks you performed in the pull request.

## Pull requests

Keep pull requests focused. Include:

- the user-visible reason for the change;
- tests for changed behavior;
- documentation updates where needed;
- the automated and manual checks you ran.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
