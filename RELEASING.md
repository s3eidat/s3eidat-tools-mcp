# Releasing

Everything here needs the owner's own logins (npm, GitHub, MCP Registry). Nothing is published automatically.

## 0. One-time setup

1. **npm account**: `npm login` (or create one at https://www.npmjs.com/signup). Turn on 2FA. The package name
   `s3eidat-tools-mcp` must be free or yours: `npm view s3eidat-tools-mcp` should print "404 Not Found" before the
   first publish.
2. **Merge to main**: the work lives on the `claude/…` branches. Open a pull request into `main`, check CI is green,
   merge.
3. **GitHub Pages** (docs site): repo Settings → Pages → Build and deployment → Source: "Deploy from a branch",
   Branch: `main`, folder: `/docs` → Save. The site appears at https://s3eidat.github.io/s3eidat-tools-mcp/ within a
   few minutes. (The cloud session that built this could not change repo settings, so this step is yours.)
4. **MCP Registry CLI** (optional, for listing in the official registry):
   `brew install mcp-publisher`, or download it from https://github.com/modelcontextprotocol/registry/releases.

## 1. Every release

From a clean checkout of `main`:

```bash
git checkout main && git pull
npm ci
npm test                 # builds and runs every tool's known-answer tests + the MCP round trip
npm run docs             # regenerate docs/ and llms.txt; commit if anything changed
```

Bump the version in **both** `package.json` and `server.json` (the tests check they match):

```bash
npm version 0.1.0 --no-git-tag-version      # or: npm version patch --no-git-tag-version
node -e 'const f="server.json",s=require("./"+f),v=require("./package.json").version;s.version=v;s.packages[0].version=v;require("fs").writeFileSync(f,JSON.stringify(s,null,2)+"\n")'
npm test
git commit -am "Release v$(node -p 'require("./package.json").version')"
git tag "v$(node -p 'require("./package.json").version')"
git push && git push --tags
```

Check what will be published, then publish:

```bash
npm pack --dry-run       # should list dist/, skills/, README.md, LICENSE, package.json only
npm publish --access public
```

Smoke-test the published package from a different folder:

```bash
cd /tmp && npx -y s3eidat-tools-mcp@latest --version && npx -y s3eidat-tools-mcp@latest --list | tail -1
npx @modelcontextprotocol/inspector npx -y s3eidat-tools-mcp
```

## 2. List it in MCP registries

Official registry (uses `server.json`; its `name` must equal `mcpName` in `package.json`, which it does):

```bash
mcp-publisher login github     # sign in as s3eidat
mcp-publisher publish
```

Then check: `curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.s3eidat/s3eidat-tools-mcp"`.

Other directories pick it up from npm/GitHub or have a submit form: Smithery (https://smithery.ai), Glama
(https://glama.ai/mcp/servers), mcp.so, PulseMCP, and the awesome-mcp-servers list (pull request).

## 3. Skill

Attach a zip of the skill to the GitHub release so people can upload it to Claude.ai:

```bash
cd skills && zip -r ../s3eidat-tools-skill.zip s3eidat-tools && cd ..
```

Create a release for the tag on GitHub and attach `s3eidat-tools-skill.zip`.

## Notes

- Node: the package supports Node 20.19+ at runtime; development and tests need Node 22+ (vitest 5).
- Native dependencies (`sharp`, `@napi-rs/canvas`) ship prebuilt binaries for macOS, Windows and Linux (x64/arm64),
  so `npx` needs no compiler.
- If a release is broken: `npm deprecate s3eidat-tools-mcp@<version> "broken, use <newer>"` and publish a fix.
  (Unpublishing is only possible within 72 hours and blocks the version number forever.)
