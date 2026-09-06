# Grasp

[![CI](https://github.com/sanjeevexe/grasp/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjeevexe/grasp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Grasp turns AI-generated code changes into questions that help you understand
what landed before you move on. It works with any editor or coding agent because
it watches the filesystem, not a specific tool integration.

> [!IMPORTANT]
> Grasp is early-alpha software. The automated suite covers macOS, Linux, and
> Windows behavior, but real-world service installation, reboot survival, and
> question quality are still being validated across platforms. Try it on a
> non-critical repository first and report anything surprising.

## Why Grasp?

AI can produce working code faster than most of us can absorb it. Grasp adds a
small, asynchronous comprehension loop:

1. You run `grasp init` once in a Git repository.
2. Grasp watches for meaningful source changes in the background.
3. It asks a bounded number of questions about those changes.
4. You answer later with `grasp review`, compare your answer with an example,
   and assess yourself.

Grasp never grades your prose. Its goal is reconstruction, not recognition: you
should be able to explain the change and plausibly rebuild it.

## Requirements

- Node.js 22.13.0 or newer (required for flag-free `node:sqlite`)
- Git
- One model-access route:
  - the [`claude` CLI](https://docs.anthropic.com/en/docs/claude-code/getting-started),
    installed and authenticated; or
  - an `ANTHROPIC_API_KEY`

Grasp has no native runtime dependencies and does not require a compiler during
installation.

## Install from source

Grasp is not published to npm yet. Install the current alpha from GitHub:

```bash
git clone https://github.com/sanjeevexe/grasp.git
cd grasp
npm ci
npm run build
npm link
```

Confirm that the CLI is available:

```bash
grasp --version
```

## Quick start

```bash
cd your-project
grasp init
```

`grasp init` registers the repository, snapshots its current source, and starts
the background service. No terminal needs to stay open. For an existing
codebase, it may suggest an onboarding scan:

```bash
grasp scan
```

Work normally, then review pending questions when you choose:

```bash
grasp status
grasp review
```

Type an answer and press Enter. Use `Alt+Enter` for a new line. Review commands
fire immediately:

| Action | Default key |
| --- | --- |
| Hint | `Ctrl+T` |
| Explain | `Ctrl+E` |
| Go deeper | `Ctrl+R` |
| Break it down | `Ctrl+K` |
| Skip | `Ctrl+N` |
| Quit | `Ctrl+C` |

Terminal emulators and multiplexers sometimes claim control keys. Rebind any
review action with `grasp set`, for example:

```bash
grasp set review.keys.hint ctrl+y
```

Grasp rejects control sequences that terminals cannot reliably distinguish or
that may suspend/freeze the terminal.

## Model access

The default provider is `auto`: Grasp uses an authenticated Claude CLI when it
can, otherwise it looks for `ANTHROPIC_API_KEY`.

```bash
grasp set provider claude-cli
grasp set provider api
grasp set provider auto
```

On the CLI path, Grasp disables tools and session persistence and runs from a
neutral directory so project-level Claude instructions are not loaded into the
generation session. Both providers use the same hourly question cap.

## Question tiers

Questions adapt to your self-reported familiarity with a concept:

| Tier | What you practice | Code visible? |
| --- | --- | --- |
| `trace` | Follow the implementation as written | Yes |
| `predict_break` | Reason about edge cases and failures | Yes |
| `reconstruct` | Describe how you would build it from the problem | No |

Mastery is shared across your local repositories and decays lazily over time.
There are no scheduled review reminders and old unanswered questions expire.

## Commands

| Command | Purpose |
| --- | --- |
| `grasp init` | Register the current repository and start background watching |
| `grasp scan [--full]` | Walk an existing codebase for onboarding |
| `grasp review [--all]` | Answer pending questions |
| `grasp status` | Show daemon, project, question, and failure state |
| `grasp history [--tag <tag>]` | Browse answered questions |
| `grasp set <key> <value>` | Update configuration |
| `grasp retry` | Retry failed generation calls |
| `grasp export --anki\|--raw` | Export question data |
| `grasp enable` / `grasp disable` | Resume or pause watching globally |
| `grasp reset config\|history` | Restore config or wipe question history |
| `grasp uninstall-hooks` | Remove Grasp's Git hooks and restore originals |

Run `grasp <command> --help` for all options.

## Configuration

Global configuration lives at `~/.grasp/config.json` with mode `0600`. A
repository can include a `.grasp.json` with non-secret overrides; Grasp ignores
and warns about an API key placed there.

Useful settings include:

```bash
grasp set maxQuestionsPerHour 6
grasp set gateMode warn
grasp set decayWindows.trace 120
```

The optional commit gate is off by default (`soft`). `warn` lists unanswered
questions related to staged files, while `hard` blocks that commit. As with any
Git hook, `git commit --no-verify` bypasses it.

## Privacy and local data

- History, mastery, project registrations, and configuration stay under
  `~/.grasp` in SQLite and JSON files.
- Grasp has no account system, analytics, telemetry, or hosted backend.
- To generate questions, Grasp sends the relevant changed-code diff (or scan
  section) to the model provider you selected. Do not use Grasp on code you are
  not allowed to send to that provider.
- Logs contain paths, counts, tags, and timings—not source text, diff bodies, or
  API keys.
- The Claude CLI route disables session persistence; the API route is still
  subject to Anthropic's API data-handling terms.

## Uninstall

```bash
grasp uninstall-hooks
grasp disable
npm unlink --global grasp
```

Grasp deliberately leaves `~/.grasp` in place so an uninstall does not silently
delete your history. Remove that directory yourself if you want the data gone.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md)
and read [DESIGN_BRIEF.md](DESIGN_BRIEF.md) before changing core product
behavior. Please report security issues through the private process in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Sanjeev Varma
