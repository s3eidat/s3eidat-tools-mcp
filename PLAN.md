# S3eidat Tools for AI: MCP server + skill + docs

Goal: every S3eidat tool that makes sense without a screen becomes an MCP tool any AI client can call
(Claude Desktop / Claude Code / Cursor / ChatGPT connectors…), plus extra tools built for AI agents.
Same promise as the website: **runs on the user's own machine, files never uploaded anywhere.**

## Shape
- npm package `s3eidat-tools-mcp` (Node ≥ 20, TypeScript, ESM), official `@modelcontextprotocol/sdk`
  (check its current docs before writing code). Transport: **stdio** (default, local) and
  **Streamable HTTP** (`--http --port 8787`, binds 127.0.0.1 only unless `--host` is given).
- `npx -y s3eidat-tools-mcp` must just work. Install snippets for Claude Desktop, Claude Code
  (`claude mcp add s3eidat -- npx -y s3eidat-tools-mcp`), Cursor, VS Code, Windsurf in the README.
- One file per tool in `src/tools/<group>/<slug>.ts`, each exporting `{ name, title, description, inputSchema (zod),
  outputSchema?, annotations (readOnlyHint, idempotentHint, openWorldHint), run }`, auto-registered from
  `src/registry.ts`. Tool names: `snake_case`, grouped prefixes (`pdf_merge`, `image_resize`, `text_case`…).
- Files in/out: inputs accept a **local path** or **base64**; outputs write to a path the caller gives (or a temp
  dir) and return the path + small metadata, never huge base64 blobs unless asked. Validate paths (no traversal
  outside the given dir when `--root` is set), size limits, clear errors.
- Every tool description says what it does, its limits, and links the matching web tool
  (`https://s3eidat.github.io/<slug>/`) for humans.
- Dependencies only from npm, permissive licenses (MIT/BSD/Apache/ISC), pure JS/WASM where possible
  (pdf-lib, pdfjs-dist, sharp OR jimp, qrcode, jsqr, exceljs, docx, pptxgenjs, js-yaml, adhan, tesseract.js…).
- Tests: vitest, one known-answer test per tool + an MCP round-trip test (spawn the server, list tools, call 3).
- CI: GitHub Actions runs build + tests on push. Release: `npm publish` is done by the owner (needs his npm login):
  leave `RELEASING.md` with the exact steps.

## Lanes (two cloud sessions)
**core** — owns `src/server.ts`, `src/registry.ts`, `src/util/*`, `src/tools/web/*`, `skills/`, `docs/`, CI.
1. First push within ~20 minutes: working scaffold (server, registry, 3 tools, test, CI) so lane extras can build on it.
2. Port the website's tools that work headless, grouped: PDF (merge, split, organize, rotate, compress, watermark,
   page numbers, metadata, to-text, images-to-pdf, pdf-to-images, sign with image, fill forms), images (convert,
   resize, compress, crop, rotate, watermark, exif read/strip, to-base64, palette, favicon set, placeholder,
   ascii art), text (word count, case, slugify, clean, diff, readability, lorem, number-to-words EN/AR,
   arabic tools, layout fixer, fancy text, morse, citation), developer (json format/validate/query, csv⇄json,
   yaml⇄json, xml format, sql format, html/css format, base64, url, hash, jwt decode, uuid/ulid, regex test,
   cron explain, timestamp, subnet, chmod, http status, gitignore, curl→code, json→types, base convert),
   calculators (loan, compound interest, percentage, discount, salary, gpa, zakat, bmi, age, date diff, unit
   convert, hijri, fraction, stats, equation solver, primes, roman, fuel, hours, due date, sleep),
   everyday (prayer times, qibla, world clock, wheel/dice/teams, secret santa, password gen/check,
   text/file encrypt-decrypt AES-GCM compatible with the website's format), QR (generate, read from image),
   barcode, wifi QR, invoice/receipt/business card/label → PDF, calendar PDF, resume → PDF.
3. **Skill**: `skills/s3eidat-tools/SKILL.md` (frontmatter name + description that triggers on PDF/image/text/
   dev/calculator chores) teaching an AI: which tool for which job, chaining (e.g. images → pdf → compress),
   privacy promise, when to send a human to the web tool instead. Plus `skills/README.md` on installing it
   (Claude Code `~/.claude/skills/`, Claude.ai upload as zip).
4. **Docs**: `README.md` (what, install per client, examples), `docs/tools.md` generated from the registry by
   `npm run docs` (every tool: name, description, inputs, outputs, example), and a GitHub Pages docs site from
   `docs/` (plain HTML/CSS, no trackers) matching s3eidat.github.io's look (dark, teal accent).
5. Also ship `llms.txt` at the docs root (short index for AI crawlers) and `server.json` / registry metadata so it
   can be listed in MCP registries.

**extras** — owns `src/tools/ai/*` only (plus its tests and its section of the docs generator output).
Tools made for AI agents, local and private:
web page → clean markdown (fetch + readability + turndown; respects robots.txt; this one does use the network,
mark `openWorldHint`), pdf/docx/pptx/xlsx/html → markdown, OCR image/scanned PDF → text (tesseract.js,
eng+ara), token count + text chunking (by tokens/headings) for RAG, CSV/XLSX query with SQL (alasql),
JSON schema validate + generate schema from samples, create documents: markdown → PDF / DOCX / PPTX / XLSX,
chart → PNG/SVG (vega-lite or chart.js + node canvas-free SVG), mermaid-free diagram (graph DSL → SVG via
dagre), zip/unzip, file type sniff, image compare (pixel diff %), color tools (contrast, palette from text),
date/timezone maths, unit + currency-free conversions, text similarity/dedupe (shingles/minhash), language
detect, Arabic transliteration, structured extraction helpers (emails, phones, URLs, dates from text),
spreadsheet formula evaluate (hyperformula, GPL? check license; skip if not permissive), template fill
(mustache → docx/pdf), audio duration/metadata (music-metadata). Pick the 25 most useful, ship them well.

## Shared rules
- Commit small (`core: …` / `extras: …`), `git pull --rebase` before every push, keep both sides on conflicts.
- Never commit secrets, never call paid APIs, no telemetry. Tests must pass before every push.
- Stop at 2026-11-05 07:00 UTC.
