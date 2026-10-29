# S3eidat Tools MCP

S3eidat Tools (https://s3eidat.github.io) as a local MCP server for AI assistants. Runs on your machine; files are never uploaded.

```bash
npx -y s3eidat-tools-mcp            # stdio
npx -y s3eidat-tools-mcp --http     # http://127.0.0.1:8787/mcp
claude mcp add s3eidat -- npx -y s3eidat-tools-mcp
```

Work in progress: full docs coming.

## Adding a tool

One file per tool in `src/tools/<group>/.../<slug>.ts` with a default export made by `defineTool()` from
`src/registry.ts` (see the comment at the top of that file). It is picked up automatically: no list to edit.
