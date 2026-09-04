# Agent notes

TanStack Start uses file-based routing — see `src/routes/README.md` for the
naming conventions before adding or renaming a route file.

Server-only logic (API keys, the estimate/vision call) lives behind
`createServerFn` boundaries in `src/lib/*-server.ts` — never call
`process.env.ANTHROPIC_API_KEY` or similar from a file imported by client
components.
