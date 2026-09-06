# Test fixtures

Real-world diffs reused across suites (DESIGN_BRIEF.md §22.1). Required cases:

- `multi-file/`      — one logical change spanning several files (batching, §4.2)
- `single-line/`     — meaningful but tiny (guards against over-filtering, §7.5)
- `formatting-only/` — must be rejected by diffFilter
- `broken-syntax/`   — partial mid-write file (the critical capture test, §22.3.2)
- `huge/`            — exceeds maxDiffLines (batch cap + rollup escape valve, §8.2)
- `binary/`          — must never reach generation
- `unicode/`         — non-ASCII identifiers and emoji in strings
- `crlf/`            — Windows line endings (path/diff normalization, §16.4)
