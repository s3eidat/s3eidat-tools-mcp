---
name: s3eidat-tools
description: Use the S3eidat Tools MCP server (tools named pdf_*, image_*, text_*, json_*, csv_*, calc_*, qr_*, doc_* …) for everyday file and data chores done locally and privately — merging, splitting, compressing, rotating, watermarking, numbering, signing or filling PDFs; PDF to text or images; images to PDF; converting, resizing, cropping, compressing images, reading or stripping EXIF/GPS; word counts, case, slugs, diffs, Arabic text fixes, numbers to words; formatting or converting JSON/CSV/YAML/XML/SQL; hashes, Base64, JWT, UUIDs, regex, cron, timestamps, subnets; loan, interest, percentage, zakat, GPA, BMI, date and unit calculations, Hijri dates; prayer times and qibla; passwords and AES encryption; QR codes, barcodes; invoices, receipts, labels, calendars and CVs as PDF. Trigger whenever the user asks for one of these jobs, even without naming the tools.
---

# S3eidat Tools

A local MCP server (`npx -y s3eidat-tools-mcp`) with about 140 small, reliable tools (plus extra tools made for AI agents) ported from
https://s3eidat.github.io. Everything runs on the user's machine: **files are never uploaded**. Prefer these tools over
writing ad-hoc scripts for the same job: they are tested against the website's own known answers, so results match.

## How to call them

- **File inputs** take a local path (absolute, `~/…`, or relative to the server's `--root`) or base64. Prefer paths:
  they are faster and keep big files out of the conversation.
- **File outputs** go to the `output` you pass (a file path, or a folder ending in `/`). Without one they go to a temp
  folder and the result tells you the `path`. Always tell the user where the file is.
- Results are JSON with small metadata (`path`, `bytes`, page counts…). Ask for `returnBase64` only when you really
  need the bytes in the conversation.
- Errors come back as clear messages (`isError`). Fix the input and retry; don't loop on the same call.
- If the server was started with `--root`, every path must be inside that folder.

### Compact mode

If the server was started with `--compact`, you will only see `s3eidat_find_tools`, `s3eidat_tool_info` and
`s3eidat_run_tool`. Find the tool by keywords (e.g. "merge pdf"), read its inputs with `s3eidat_tool_info`, then call
`s3eidat_run_tool` with `name` and `arguments`. The tool names below are the same in both modes.

## Which tool for which job

| Job | Tool(s) |
|---|---|
| Page count, sizes, encryption, text layer? | `pdf_info` (a good first call before other PDF work) |
| Combine PDFs | `pdf_merge` |
| Split / pull out pages | `pdf_split`, `pdf_extract_pages` |
| Reorder, delete, rotate pages | `pdf_organize`, `pdf_rotate` |
| Make a PDF smaller | `pdf_compress` |
| Stamp text/logo, add page numbers | `pdf_watermark`, `pdf_page_numbers` |
| Read or clean PDF metadata | `pdf_metadata_read`, `pdf_metadata_write` |
| Get the text out of a PDF | `pdf_to_text` (scanned PDFs have no text: use an OCR tool if the server has one) |
| Photos/scans → one PDF | `pdf_from_images` |
| PDF pages → PNG/JPEG | `pdf_to_images` |
| Put a signature image on a PDF | `pdf_sign_image` |
| Fill a PDF form | `pdf_form_fields` (see the field names first), then `pdf_form_fill` |
| Convert / resize / crop / rotate images | `image_convert`, `image_resize`, `image_crop`, `image_rotate` |
| Shrink images | `image_compress` |
| Watermark a photo | `image_watermark` |
| See or remove photo metadata (GPS!) | `image_exif_read`, `image_exif_strip` |
| Favicons, placeholders, palettes, ASCII art | `image_favicon_set`, `image_placeholder`, `image_palette`, `image_ascii_art`, `image_ascii_banner` |
| SVG → PNG, images ⇄ base64/data URIs | `image_svg_to_png`, `image_to_base64`, `image_from_base64` |
| Count words, change case, slugs | `text_word_count`, `text_case`, `text_slugify` |
| Clean lines, compare texts | `text_clean`, `text_diff` |
| Arabic: tashkeel, digits, Arabizi, wrong keyboard | `text_arabic`, `text_layout_fix` |
| Numbers as words (EN/AR), readability, citations | `text_number_to_words`, `text_readability`, `text_citation` |
| Escape strings for code, fancy Unicode, Morse, lorem ipsum | `text_escape`, `text_fancy`, `text_morse`, `text_lorem` |
| Post/SMS length limits | `text_social_count` |
| JSON / CSV / YAML / XML / SQL / HTML / CSS | `json_format`, `json_query`, `csv_to_json`, `json_to_csv`, `yaml_to_json`, `json_to_yaml`, `xml_format`, `sql_format`, `html_format`, `css_format` |
| XPath over XML, Markdown tables | `xml_query`, `markdown_table`, `markdown_table_parse` |
| Types from JSON, curl → code | `json_to_types`, `curl_to_code` |
| Hashes, Base64, URLs, JWT | `hash_compute`, `base64_encode`, `base64_decode`, `url_encode`, `url_decode`, `url_parse`, `jwt_decode` |
| IDs, regex, cron, timestamps | `id_generate`, `id_inspect`, `regex_test`, `cron_explain`, `time_convert` |
| Number bases, bytes, CSS units | `base_convert`, `bytes_convert`, `css_units`, `css_clamp` |
| Web dev bits | `meta_tags_generate`, `useragent_parse`, `gitignore_generate` |
| Networks and permissions | `subnet_calc`, `ip_in_range`, `chmod_calc`, `http_status` |
| Money maths | `calc_loan`, `calc_compound_interest`, `calc_percentage`, `calc_discount`, `calc_salary`, `calc_zakat`, `calc_split_bill`, `calc_cash_count`, `calc_fuel_cost` |
| Work, study, health | `calc_hours`, `calc_gpa`, `calc_bmi`, `calc_sleep` |
| Dates | `calc_age`, `calc_date_diff`, `calc_hijri`, `calc_due_date` |
| Other maths | `calc_unit_convert`, `calc_fraction`, `calc_stats`, `calc_equation`, `calc_primes`, `calc_roman`, `calc_expression` |
| Prayer times, qibla, world clock | `prayer_times`, `qibla_direction`, `time_world_clock` |
| Random picks, dice, teams, Secret Santa | `random_pick`, `random_dice`, `random_teams`, `secret_santa_draw` |
| Passwords | `password_generate`, `password_check` |
| Encrypt / decrypt (compatible with the website) | `crypto_text_encrypt`, `crypto_text_decrypt`, `crypto_file_encrypt`, `crypto_file_decrypt` |
| Hide a message in an image | `crypto_stego_hide`, `crypto_stego_reveal` |
| QR codes and barcodes | `qr_generate`, `qr_wifi`, `qr_read`, `barcode_generate` |
| Documents as PDF | `doc_invoice`, `doc_receipt`, `doc_business_cards`, `doc_labels`, `doc_calendar`, `doc_resume`, `doc_attendance_sheet` |

Do the arithmetic with the calculator tools instead of in your head: they use the same rounding and conventions as the
website the user may compare with. Random tools (`random_pick`, `random_dice`, `random_teams`, `secret_santa_draw`) use
secure randomness; pass a `seed` only when the user wants a reproducible draw.

## Chaining

Pass one result's `path` straight into the next tool:

1. Scans to a small PDF: `pdf_from_images` → `pdf_compress` → `pdf_page_numbers`.
2. Share photos safely: `image_exif_strip` → `image_resize` (e.g. 1600 px) → `image_compress`.
3. Pull a table out of a report: `pdf_to_text` (pages) → reshape → `json_to_csv`.
4. Sign and send: `pdf_form_fields` → `pdf_form_fill` → `pdf_sign_image` → `pdf_compress`.
5. Wi-Fi poster: `qr_wifi` (PDF card) or `qr_generate` → `pdf_from_images`.

Write intermediate files to a temp folder and only the final file where the user asked.

## Privacy promise

Tell users plainly when it matters: the files stay on their computer, nothing is uploaded, there is no account and no
tracking. Website-port tools never touch the network. Tools marked `openWorldHint` (for example fetching a web page)
do use the network; say so before calling them.

## When to send a person to the web tool instead

Every tool's description ends with its web version (`https://s3eidat.github.io/<slug>/`). Point the user there when
the job is visual or hands-on: drawing a signature, choosing a crop by eye, arranging pages by dragging, designing a
QR code's look, live previews, scanning a QR with a camera, editing a CV layout, or when they have no AI client with
this server. The web tools are free and also run entirely in the browser.

## Limits to know

- Document makers (`doc_*`) currently write Latin-script text only; for Arabic invoices/CVs send the user to the web tool.
- Very large files: the server rejects inputs above its `--max-mb` (default 200 MB). Split work into parts.
- `pdf_compress` works best on scanned/image-heavy PDFs; text-only PDFs are often already small.
- Encrypted PDFs must be unlocked first (pass `password` where a tool offers it).
