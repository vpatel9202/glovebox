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
npm test                # unit tests; run anywhere (Node 22+: node --test test/unit.test.mjs)
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

## Releasing

The version lives in five places (`package.json`, `package-lock.json`,
`server.json`, `src/config.mjs`, and `helperVersion` in
`native/macos/GloveboxHelper.swift`). One command sets them all and dates the
`## Unreleased` section of the changelog:

```bash
npm run version:bump 0.4.0
git commit -am "Release 0.4.0: <one line>"
git tag v0.4.0
git push origin main v0.4.0
```

Pushing the tag runs `.github/workflows/release.yml`. It checks that the tag
is on `main`, that every version matches it, and that the tests pass. Then it
publishes to npm (with provenance), then to the official MCP Registry
(`io.github.vpatel9202/glovebox` from `server.json`), and creates a GitHub
Release from that version's changelog section. Each step skips what is
already done, so a failed run can be re-run from the Actions tab, or started
by hand for an existing tag (`workflow_dispatch`).

One-time setup for npm, either of:

- **Trusted publishing (no secret).** On npmjs.com, open
  `@vashp2029/glovebox` > Settings > Trusted Publisher, choose GitHub
  Actions, and enter owner `vpatel9202`, repository `glovebox`, workflow
  `release.yml` (no environment).
- **A token.** Create a granular access token on npmjs.com that can publish
  this package, and save it as the repository secret `NPM_TOKEN`.

The MCP Registry needs no setup: the workflow signs in with its GitHub OIDC
token, which owns the `io.github.vpatel9202/` namespace.
