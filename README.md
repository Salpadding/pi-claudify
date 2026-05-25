# pi-claudify

A pi coding-agent extension that adds Claude Code-inspired workflow features to pi.

> This is an independent project. It is not affiliated with Anthropic or Claude Code.

## Features

- Loads `CLAUDE.md` project instructions into the agent context.
- Adds Claude Code-style helper tools, including bash with stdin/env support, PDF reading, user-question prompts, Neovim execution, and direct Python/Ruby/Node snippets.
- Provides edit approval modes via `/edit-mode`.
- Exposes a small local status/API server over a Unix socket.
- Includes an optional light chat UI bundle.

## Requirements

- Node.js
- pnpm
- pi coding-agent packages compatible with the versions in `package.json`
- Optional external tools for some features, such as Neovim and PDF utilities (`pdfinfo`/`pdftoppm`).

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Build output is written to `dist/`.

## Local install for pi

```sh
make install
```

This builds the extension and links `dist/` into the local pi extension directory.

## Notes

- `CLAUDE.md` and `.claude/CLAUDE.md` files are treated as project instruction files.
- `CLAUDE.local.md` and `.claude/settings.local.json` are intended for local-only configuration and should not be committed.

## License

MIT
