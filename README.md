# S3eidat Tools MCP

**The free, private [S3eidat Tools](https://s3eidat.github.io/) as tools your AI assistant can use.**
PDF, images, text, developer chores, calculators, QR codes and document makers, served by a local
[MCP](https://modelcontextprotocol.io) server. It runs on your own machine: **your files are never uploaded anywhere**,
there is no account, no API key and no telemetry.

Works with Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI and any other MCP client.

```bash
npx -y s3eidat-tools-mcp
```

Docs site: https://s3eidat.github.io/s3eidat-tools-mcp/ · Tool reference: [docs/tools.md](docs/tools.md) · Skill: [skills/](skills/)

## What you can ask

- "Merge these three PDFs, compress the result and add page numbers."
- "Turn every photo in ~/Desktop/receipts into one PDF."
- "Resize this image to 1200 px wide as WebP and strip the GPS data."
- "Format this JSON and convert it to YAML." · "What does this cron expression mean?"
- "Monthly payment on a 250,000 loan at 5.2% over 25 years?" · "Prayer times in Amman tomorrow."
- "Make a QR code for my Wi-Fi." · "Make an invoice PDF for these items."

## Install

You need [Node.js](https://nodejs.org) 20.19 or newer (22+ recommended). The first run downloads the package; later runs start instantly.

### Claude Code

```bash
claude mcp add s3eidat -s user -- npx -y s3eidat-tools-mcp
```

### Claude Desktop

**One click:** download the `.mcpb` file for your computer from the
[latest release](https://github.com/s3eidat/s3eidat-tools-mcp/releases/latest) and double-click it (or drag it into
Settings → Extensions). It includes everything, so you don't even need Node.js. You can pick an allowed folder and an
output folder in the extension's settings.

**Or by hand:** Settings → Developer → Edit Config, then add to `claude_desktop_config.json` and restart Claude:

```json
{
  "mcpServers": {
    "s3eidat": {
      "command": "npx",
      "args": ["-y", "s3eidat-tools-mcp"]
    }
  }
}
```

On Windows, if Claude can't find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "s3eidat-tools-mcp"]`.

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "s3eidat": { "command": "npx", "args": ["-y", "s3eidat-tools-mcp"] }
  }
}
```

### VS Code (Copilot agent mode)

```bash
code --add-mcp '{"name":"s3eidat","command":"npx","args":["-y","s3eidat-tools-mcp"]}'
```

or `.vscode/mcp.json` in a workspace:

```json
{
  "servers": {
    "s3eidat": { "type": "stdio", "command": "npx", "args": ["-y", "s3eidat-tools-mcp"] }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "s3eidat": { "command": "npx", "args": ["-y", "s3eidat-tools-mcp"] }
  }
}
```

### Codex CLI

```bash
codex mcp add s3eidat -- npx -y s3eidat-tools-mcp
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "s3eidat": { "command": "npx", "args": ["-y", "s3eidat-tools-mcp"] }
  }
}
```

### Any other client (Streamable HTTP)

```bash
npx -y s3eidat-tools-mcp --http --port 8787
```

Then point the client at `http://127.0.0.1:8787/mcp`. It only listens on your own machine unless you pass `--host`.
Hosted chat apps (ChatGPT, claude.ai) can only reach servers on the public internet; exposing this server there would
expose your files, so use a desktop/CLI client instead.

## Options

| Option | What it does |
|---|---|
| `--root <dir>` | Only allow reading and writing files inside `<dir>` (recommended for shared machines). |
| `--out-dir <dir>` | Where outputs go when a tool call gives no `output` path (default: a temp folder). |
| `--max-mb <n>` | Largest input file in MB (default 200). |
| `--groups pdf,image` | Only expose these groups: `pdf`, `image`, `text`, `data`, `dev`, `calc`, `everyday`, `qr`, `docs`, `ai`. |
| `--compact` | Expose 3 small meta-tools (`s3eidat_find_tools`, `s3eidat_tool_info`, `s3eidat_run_tool`) instead of every tool. |
| `--only pdf_,image_` | Only expose tools whose names start with these prefixes. |
| `--output-schemas` | Also advertise each tool's output JSON Schema (results always include structured JSON either way). |
| `--http`, `--port`, `--host` | Serve Streamable HTTP instead of stdio. |
| `--list` | Print every tool and exit. |

Example: `"args": ["-y", "s3eidat-tools-mcp", "--root", "/Users/me/Documents"]`.

### Many tools, small context?

The full list is about 140 tools, roughly 65k tokens of tool definitions. Clients with tool search (Claude Code) handle
that well. If your client has a tool limit (Cursor, Windsurf) or you use a small model, either pick groups
(`--groups pdf,image` is about 17k tokens) or use `--compact` (about 600 tokens): the model then searches for a tool,
reads its inputs and runs it through three meta-tools.

```json
{ "mcpServers": { "s3eidat": { "command": "npx", "args": ["-y", "s3eidat-tools-mcp", "--compact"] } } }
```

## How files work

- **Inputs** take a local path (absolute, `~/…`, or relative to `--root`) or base64 (raw, `base64:…`, or a `data:` URI).
- **Outputs** are written to the `output` you give (a file path, or a folder ending in `/`), or to the output folder.
  Results return the path and small metadata, not big base64 blobs (set `returnBase64` where offered if you need the bytes).
- Chain tools by passing one result's `path` to the next tool: `pdf_from_images` → `pdf_compress` → `pdf_page_numbers`.

## Tools

<!-- tools:start -->
**162 tools.** Full reference: [docs/tools.md](docs/tools.md).

| Group | Count | Tools |
|---|---|---|
| PDF | 17 | `pdf_compress`, `pdf_extract_pages`, `pdf_form_fields`, `pdf_form_fill`, `pdf_from_images`, `pdf_info`, `pdf_merge`, `pdf_metadata_read`, `pdf_metadata_write`, `pdf_organize`, `pdf_page_numbers`, `pdf_rotate`, `pdf_sign_image`, `pdf_split`, `pdf_to_images`, `pdf_to_text`, `pdf_watermark` |
| Images | 16 | `image_ascii_art`, `image_ascii_banner`, `image_compress`, `image_convert`, `image_crop`, `image_exif_read`, `image_exif_strip`, `image_favicon_set`, `image_from_base64`, `image_palette`, `image_placeholder`, `image_resize`, `image_rotate`, `image_svg_to_png`, `image_to_base64`, `image_watermark` |
| Text | 15 | `text_arabic`, `text_case`, `text_citation`, `text_clean`, `text_diff`, `text_escape`, `text_fancy`, `text_layout_fix`, `text_lorem`, `text_morse`, `text_number_to_words`, `text_readability`, `text_slugify`, `text_social_count`, `text_word_count` |
| Developer: data formats | 15 | `css_format`, `csv_to_json`, `curl_to_code`, `html_format`, `json_format`, `json_query`, `json_to_csv`, `json_to_types`, `json_to_yaml`, `markdown_table`, `markdown_table_parse`, `sql_format`, `xml_format`, `xml_query`, `yaml_to_json` |
| Developer: utilities | 23 | `base_convert`, `base64_decode`, `base64_encode`, `bytes_convert`, `chmod_calc`, `cron_explain`, `css_clamp`, `css_units`, `gitignore_generate`, `hash_compute`, `http_status`, `id_generate`, `id_inspect`, `ip_in_range`, `jwt_decode`, `meta_tags_generate`, `regex_test`, `subnet_calc`, `time_convert`, `url_decode`, `url_encode`, `url_parse`, `useragent_parse` |
| Calculators | 24 | `calc_age`, `calc_bmi`, `calc_cash_count`, `calc_compound_interest`, `calc_date_diff`, `calc_discount`, `calc_due_date`, `calc_equation`, `calc_expression`, `calc_fraction`, `calc_fuel_cost`, `calc_gpa`, `calc_hijri`, `calc_hours`, `calc_loan`, `calc_percentage`, `calc_primes`, `calc_roman`, `calc_salary`, `calc_sleep`, `calc_split_bill`, `calc_stats`, `calc_unit_convert`, `calc_zakat` |
| Everyday & security | 15 | `crypto_file_decrypt`, `crypto_file_encrypt`, `crypto_stego_hide`, `crypto_stego_reveal`, `crypto_text_decrypt`, `crypto_text_encrypt`, `password_check`, `password_generate`, `prayer_times`, `qibla_direction`, `random_dice`, `random_pick`, `random_teams`, `secret_santa_draw`, `time_world_clock` |
| QR & barcodes | 4 | `barcode_generate`, `qr_generate`, `qr_read`, `qr_wifi` |
| Document makers | 7 | `doc_attendance_sheet`, `doc_business_cards`, `doc_calendar`, `doc_invoice`, `doc_labels`, `doc_receipt`, `doc_resume` |
| For AI agents | 26 | `ai_chart`, `ai_chunk_text`, `ai_create_pptx`, `ai_create_xlsx`, `ai_csv_profile`, `ai_detect_language`, `ai_diagram`, `ai_docx_to_markdown`, `ai_extract_entities`, `ai_file_identify`, `ai_html_to_markdown`, `ai_image_diff`, `ai_json_schema_infer`, `ai_json_schema_validate`, `ai_markdown_to_docx`, `ai_markdown_to_pdf`, `ai_media_info`, `ai_ocr`, `ai_pdf_to_markdown`, `ai_pptx_to_markdown`, `ai_sql_query`, `ai_text_similarity`, `ai_token_count`, `ai_web_fetch`, `ai_xlsx_to_markdown`, `ai_zip` |
<!-- tools:end -->

Every tool's description links the matching web tool on https://s3eidat.github.io for people who prefer a visual version.

## The skill

[`skills/s3eidat-tools`](skills/s3eidat-tools/SKILL.md) teaches an AI which tool fits which job, how to chain them and
when to send a person to the web tool instead. Install steps: [skills/README.md](skills/README.md).

## Privacy

Everything runs locally in the Node process on your machine. The website ports make no network requests at all. A few
tools in the "For AI agents" group (such as fetching a web page as Markdown) do use the network; they are marked with
`openWorldHint` so your client can ask before running them. No analytics, no telemetry, no accounts.

## Support

The tools are free. If they save you time, [buy me a coffee ☕](https://s3eidat.github.io/coffee/). Want an AI that
reads your PDFs, writes and translates? Try [s3eidatGPT](https://ai.s3eidat.com/?ref=s3tools-mcp).

## Development

```bash
npm ci
npm test          # builds, runs known-answer tests for every tool and an MCP round trip
npm run docs      # regenerates docs/tools.md, docs/*.html, docs/llms.txt
npm run smoke     # drives the built server over MCP stdio
npm run mcpb      # builds a Claude Desktop extension for this platform into mcpb/out/
node dist/index.js --list
npx @modelcontextprotocol/inspector node dist/index.js
```

Adding a tool: one file in `src/tools/<group>/…/<slug>.ts` whose default export is `defineTool({...})` from
[`src/registry.ts`](src/registry.ts) (the contract is documented at the top of that file). It is discovered
automatically. Add a known-answer test in `test/`. Releasing: [RELEASING.md](RELEASING.md).

## License

MIT © Omar (s3eidat)
