# Contributing

nostrings is small: plain JavaScript, one dependency, a Swift helper for the
Mac and a Java server for Android. Keep changes focused and say what you ran.

Good places to start: [issues labelled good first
issue](https://github.com/vpatel9202/nostrings/issues?q=is%3Aopen+label%3A%22good+first+issue%22),
a new [example script](examples/README.md), or a [backend
port](#porting-a-backend). Questions and ideas go in
[Discussions](https://github.com/vpatel9202/nostrings/discussions).

## Requirements

- Node 20.10 or later. Unit tests and the conformance check run on any OS.
- For the Mac side: macOS 14 or later (tested on macOS 27, Apple silicon) and
  the Xcode command line tools (`xcode-select --install`).
- For Android: `adb`, and the Android SDK plus a JDK to rebuild the server
  (`npm run build:android`).

## Setup

```bash
git clone https://github.com/vpatel9202/nostrings.git
cd nostrings
npm install
node bin/nostrings.mjs setup
node bin/nostrings.mjs doctor   # every line should say ok
```

In a clone, use `node bin/nostrings.mjs` in place of `nostrings`.

`setup` builds Nostrings Helper.app into `~/.nostrings/` and walks you through
the macOS permissions. See the README for the signing option.

## Tests

```bash
npm test                 # unit tests and the conformance check on a fake backend; any OS
nostrings smoke          # GUI test on Calculator (macOS only)
nostrings smoke --full   # adds background click, drag, and scroll checks in TextEdit (macOS only)
nostrings smoke --macos  # 51 checks on a test app (macOS only)
nostrings smoke --android --serial emulator-5554   # 20 checks on a test app
```

Unit tests cover cell rewriting, key parsing, tree diffs, coordinate mapping,
saved scripts, agent configs, and the backend contract. The smoke tests drive
real apps and need the helper's permissions; read
[docs/testing.md](docs/testing.md) first.

For kernel logs on stderr:

```bash
NOSTRINGS_DEBUG=1 nostrings mcp
```

## Docs

- `docs/api.md` is served verbatim by `help()` inside agent sessions
  (`src/kernel.mjs`). It is split on `## ` headings, so keep it terse and keep
  the headings.
- `docs/design.md` records decisions and their reasons. When you change
  behavior, change the reasons there too.
- Update `CHANGELOG.md` for user-visible changes.

## Porting a backend

Windows and Linux are the most wanted contributions. A backend is one native
program that speaks JSON lines ([docs/backend-protocol.md](docs/backend-protocol.md))
and needs no change to the scripting layer.

1. Start from [test/fake-backend.mjs](test/fake-backend.mjs), the smallest
   backend that passes, and the plan for your OS in
   [docs/roadmap.md](docs/roadmap.md) (UI Automation on Windows, AT-SPI on
   Linux).
2. Make the read side pass: `nostrings conformance --command "your backend"
   --app <an app>`. That is enough for an agent to read the screen.
3. Add input (`keys`, `type`, `click`, `scroll`) and check it with
   `--input`, then wire the backend into `src/backends/index.mjs`.
4. Open a draft pull request early with the conformance output. Say which OS
   version and apps you tried.

## Security

Report security issues through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

- Keep PRs small: one change, one reason.
- In the description, list what you ran (`npm test`, `nostrings smoke`,
  `nostrings smoke --full`) and the macOS version. Say which checks you did not run.
- Update the docs above when behavior changes.

## Releasing

The version lives in five places (`package.json`, `package-lock.json`,
`server.json`, `src/config.mjs`, and `helperVersion` in
`native/macos/NostringsHelper.swift`). One command sets them all and dates the
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
(`io.github.vpatel9202/nostrings` from `server.json`), and creates a GitHub
Release from that version's changelog section. Each step skips what is
already done, so a failed run can be re-run from the Actions tab, or started
by hand for an existing tag (`workflow_dispatch`).

One-time setup for npm, either of:

- **Trusted publishing (no secret).** On npmjs.com, open
  `nostrings` > Settings > Trusted Publisher, choose GitHub
  Actions, and enter owner `vpatel9202`, repository `nostrings`, workflow
  `release.yml` (no environment).
- **A token.** Create a granular access token on npmjs.com that can publish
  this package, and save it as the repository secret `NPM_TOKEN`.

The MCP Registry needs no setup: the workflow signs in with its GitHub OIDC
token, which owns the `io.github.vpatel9202/` namespace.
