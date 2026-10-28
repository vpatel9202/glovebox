# Contributing

glovebox is small and macOS-only for now. Keep changes focused and say what
you ran.

## Requirements

- macOS 14 or later (tested on macOS 27, Apple silicon)
- Node 20.10 or later
- Xcode command line tools: `xcode-select --install`

## Setup

```bash
git clone https://github.com/vpatel9202/glovebox.git
cd glovebox
npm install
node bin/glovebox.mjs setup
node bin/glovebox.mjs doctor   # every line should say ok
```

In a clone, use `node bin/glovebox.mjs` in place of `glovebox`.

`setup` builds Glovebox Helper.app into `~/.glovebox/` and walks you through
the macOS permissions. See the README for the signing option.

## Tests

```bash
npm test                # unit tests; run anywhere
glovebox smoke          # GUI test on Calculator (macOS only)
glovebox smoke --full   # adds background click, drag, and scroll checks in TextEdit (macOS only)
```

Unit tests cover cell rewriting, key parsing, tree diffs, and coordinate
mapping. The smoke tests drive real apps and need the helper's permissions.

For kernel logs on stderr:

```bash
GLOVEBOX_DEBUG=1 glovebox mcp
```

## Docs

- `docs/api.md` is served verbatim by `help()` inside agent sessions
  (`src/kernel.mjs`). It is split on `## ` headings, so keep it terse and keep
  the headings.
- `docs/design.md` records decisions and their reasons. When you change
  behavior, change the reasons there too.
- Update `CHANGELOG.md` for user-visible changes.

## Porting

A new backend implements [docs/backend-protocol.md](docs/backend-protocol.md).
The Windows and Linux plans are in [docs/roadmap.md](docs/roadmap.md).

## Security

Report security issues through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

- Keep PRs small: one change, one reason.
- In the description, list what you ran (`npm test`, `glovebox smoke`,
  `glovebox smoke --full`) and the macOS version. Say which checks you did not run.
- Update the docs above when behavior changes.
