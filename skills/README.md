# The S3eidat Tools skill

`skills/s3eidat-tools/SKILL.md` teaches an AI assistant which S3eidat tool fits which job, how to chain tools, the
privacy promise, and when to send a person to the web version instead. It works together with the MCP server
(`npx -y s3eidat-tools-mcp`): install the server first (see the main README), then the skill.

## Claude Code

Personal (all projects):

```bash
mkdir -p ~/.claude/skills
cp -r skills/s3eidat-tools ~/.claude/skills/
```

Or for one project: copy the folder to `.claude/skills/s3eidat-tools/` in that project. Without cloning the repo:

```bash
mkdir -p ~/.claude/skills/s3eidat-tools && curl -fsSL https://raw.githubusercontent.com/s3eidat/s3eidat-tools-mcp/main/skills/s3eidat-tools/SKILL.md -o ~/.claude/skills/s3eidat-tools/SKILL.md
```

The npm package also ships the skill: `cp -r "$(npm root -g)/s3eidat-tools-mcp/skills/s3eidat-tools" ~/.claude/skills/` after `npm i -g s3eidat-tools-mcp`.

## Claude.ai and Claude Desktop

1. Download the folder as a zip: `skills/s3eidat-tools/` must be the top folder inside the zip
   (`cd skills && zip -r s3eidat-tools.zip s3eidat-tools`).
2. In Claude: Settings → Capabilities → Skills → Upload skill, and pick the zip.
3. Make sure the S3eidat Tools MCP server is connected in Claude Desktop (claude.ai on the web can't reach a local server,
   so there the skill mainly helps Claude point people to the right web tool).

## Other assistants

Most agents that read Markdown instructions can use `SKILL.md` as-is: add it to the agent's rules/instructions file
(for example `AGENTS.md`, Cursor rules, or a Copilot instructions file).
