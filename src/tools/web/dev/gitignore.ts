import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineTool, ToolError, webUrl } from '../../../registry.js';
import { outputPath, resolvePath, writeOutput } from '../../../util/files.js';

// Ported from https://github.com/s3eidat/gitignore-gen (app.js): the same hand-written templates (copied verbatim by
// script) and the same merge: de-duplicated patterns, section headers, empty comment groups dropped.
type Template = [id: string, name: string, group: string, keywords: string, body: string];
// [id, name, group, keywords, body]
export const T: Template[] = [
    ["node", "Node.js", "Language", "npm yarn pnpm javascript typescript bun", `
# Dependencies
node_modules/
jspm_packages/
.pnp.*
.yarn/*
!.yarn/patches
!.yarn/plugins
!.yarn/releases
!.yarn/versions

# Logs
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Build output and caches
dist/
build/
coverage/
.nyc_output/
.cache/
.eslintcache
.stylelintcache
*.tsbuildinfo
.parcel-cache/
.turbo/

# Environment
.env
.env.*
!.env.example`],
    ["python", "Python", "Language", "pip venv pytest jupyter poetry conda", `
# Byte-compiled files
__pycache__/
*.py[cod]
*$py.class

# Packaging
build/
dist/
*.egg-info/
.eggs/
wheels/
pip-wheel-metadata/

# Virtual environments
.venv/
venv/
env/
ENV/

# Tests and tooling
.pytest_cache/
.coverage
.coverage.*
htmlcov/
.tox/
.nox/
.mypy_cache/
.ruff_cache/
.pyre/

# Jupyter
.ipynb_checkpoints/

# Environment
.env`],
    ["java", "Java / Gradle / Maven", "Language", "kotlin jvm gradle maven spring", `
# Compiled files
*.class
*.jar
*.war
*.ear
hs_err_pid*

# Gradle
.gradle/
build/
!gradle/wrapper/gradle-wrapper.jar

# Maven
target/
pom.xml.tag
pom.xml.releaseBackup
pom.xml.versionsBackup
release.properties
dependency-reduced-pom.xml

# Kotlin
.kotlin/`],
    ["android", "Android", "Mobile", "kotlin gradle apk studio", `
# Gradle and build
.gradle/
build/
captures/
.externalNativeBuild/
.cxx/
*.apk
*.aab
*.ap_
*.dex

# Local configuration
local.properties

# Android Studio
*.iml
.idea/
.navigation/

# Signing keys
*.jks
*.keystore

# Generated
gen/
out/
google-services.json`],
    ["ios", "iOS / Xcode", "Mobile", "swift xcode apple cocoapods carthage spm", `
# Xcode
build/
DerivedData/
*.xcuserstate
xcuserdata/
*.xccheckout
*.moved-aside
*.hmap
*.ipa
*.dSYM.zip
*.dSYM

# Swift Package Manager
.build/
.swiftpm/

# CocoaPods
Pods/

# Carthage
Carthage/Build/

# fastlane
fastlane/report.xml
fastlane/Preview.html
fastlane/screenshots/**/*.png
fastlane/test_output`],
    ["flutter", "Flutter / Dart", "Mobile", "dart pub", `
# Dart and Flutter
.dart_tool/
.packages
.pub-cache/
.pub/
build/
.flutter-plugins
.flutter-plugins-dependencies
*.g.dart.tmp

# Generated platform files
**/ios/Flutter/.last_build_id
**/ios/Flutter/Generated.xcconfig
**/ios/Flutter/flutter_export_environment.sh
**/android/app/debug
**/android/app/profile
**/android/app/release

# Symbols and obfuscation
app.*.symbols
app.*.map.json`],
    ["reactnative", "React Native", "Mobile", "expo metro", `
# Dependencies
node_modules/

# Metro and Expo
.metro-health-check*
.expo/
web-build/
expo-env.d.ts

# Native builds
ios/Pods/
ios/build/
android/.gradle/
android/app/build/
android/build/
*.jsbundle

# Signing
*.keystore
!debug.keystore
*.jks
*.p8
*.p12
*.mobileprovision`],
    ["unity", "Unity", "Game", "game engine csharp", `
# Unity generated folders
/[Ll]ibrary/
/[Tt]emp/
/[Oo]bj/
/[Bb]uild/
/[Bb]uilds/
/[Ll]ogs/
/[Uu]ser[Ss]ettings/
/[Mm]emoryCaptures/
/[Rr]ecordings/

# Asset meta data should only be ignored when the corresponding asset is also ignored
!/[Aa]ssets/**/*.meta

# IDE and generated project files
.vs/
.consulo/
*.csproj
*.unityproj
*.sln
*.suo
*.user
*.userprefs
*.pidb
*.booproj
*.svd
*.pdb
*.mdb
*.opendb
*.VC.db

# Builds
*.apk
*.aab
*.unitypackage
crashlytics-build.properties`],
    ["unreal", "Unreal Engine", "Game", "game engine cpp ue5", `
# Unreal generated folders
Binaries/
DerivedDataCache/
Intermediate/
Saved/
Build/
.vs/

# Project files that are generated
*.sln
*.VC.db
*.opensdf
*.opendb
*.sdf
*.suo
*.xcodeproj
*.xcworkspace

# Compiled files
*.pdb
*.dll
*.exe
*.dylib
*.so

# Plugins keep their source
Plugins/**/Binaries/
Plugins/**/Intermediate/`],
    ["go", "Go", "Language", "golang", `
# Binaries
*.exe
*.exe~
*.dll
*.so
*.dylib
/bin/

# Test output
*.test
*.out
coverage.*
*.coverprofile

# Workspace and vendoring
go.work
go.work.sum
vendor/

# Environment
.env`],
    ["rust", "Rust", "Language", "cargo", `
# Build output
target/
debug/

# Backup files from rustfmt
**/*.rs.bk

# Debug info
*.pdb

# Libraries can ignore the lock file; applications should commit it
# Cargo.lock`],
    ["cpp", "C / C++", "Language", "c cmake make clang gcc", `
# Object files
*.o
*.ko
*.obj
*.elf
*.d

# Precompiled headers
*.gch
*.pch

# Libraries
*.lib
*.a
*.la
*.lo
*.dll
*.so
*.so.*
*.dylib

# Executables
*.exe
*.out
*.app

# CMake
CMakeCache.txt
CMakeFiles/
cmake-build-*/
cmake_install.cmake
compile_commands.json
build/`],
    ["dotnet", ".NET / C#", "Language", "csharp visual studio nuget aspnet", `
# Build results
[Bb]in/
[Oo]bj/
[Dd]ebug/
[Rr]elease/
x64/
x86/
[Ll]og/
[Ll]ogs/

# Visual Studio
.vs/
*.suo
*.user
*.userosscache
*.sln.docstates
*.rsuser

# NuGet
*.nupkg
*.snupkg
**/packages/*
!**/packages/build/
project.lock.json
project.fragment.lock.json

# Tests
TestResults/
[Tt]est[Rr]esult*/
*.trx
coverage*.json
coverage*.xml

# Publish
publish/
*.pubxml
appsettings.Development.json`],
    ["php", "PHP / Laravel", "Language", "composer laravel symfony", `
# Composer
/vendor/
composer.phar

# Laravel
/node_modules/
/public/build/
/public/hot
/public/storage
/storage/*.key
/storage/pail
.env
.env.backup
.env.production
.phpunit.result.cache
.phpunit.cache/
Homestead.json
Homestead.yaml
auth.json
npm-debug.log
yarn-error.log

# Caches
.php-cs-fixer.cache
.php_cs.cache`],
    ["wordpress", "WordPress", "Framework", "wp cms php", `
# WordPress core config and uploads
wp-config.php
wp-content/uploads/
wp-content/upgrade/
wp-content/cache/
wp-content/backup-db/
wp-content/backups/
wp-content/blogs.dir/
wp-content/advanced-cache.php
wp-content/wp-cache-config.php
wp-content/debug.log
sitemap.xml
sitemap.xml.gz

# Environment
.htaccess
.env`],
    ["rails", "Ruby / Rails", "Framework", "ruby bundler gem", `
# Bundler
/.bundle
/vendor/bundle

# Rails
/log/*
/tmp/*
!/log/.keep
!/tmp/.keep
/storage/*
!/storage/.keep
/public/assets
/public/packs
/node_modules
/config/master.key
/config/credentials/*.key
.byebug_history

# Gems and tests
*.gem
/coverage/
/spec/reports/
.rspec_status

# Environment
.env`],
    ["django", "Django", "Framework", "python web", `
# Django
*.log
local_settings.py
db.sqlite3
db.sqlite3-journal
media/
staticfiles/
/static_root/

# Python
__pycache__/
*.py[cod]
.venv/
venv/
.env`],
    ["nextjs", "Next.js", "Framework", "react vercel node", `
# Next.js
/.next/
/out/
next-env.d.ts

# Production
/build

# Vercel
.vercel

# Dependencies
node_modules/

# Environment
.env*.local
.env`],
    ["vite", "Vite", "Framework", "react vue svelte frontend", `
# Vite
node_modules/
dist/
dist-ssr/
*.local
.vite/

# Logs
*.log

# Environment
.env
.env.*.local`],
    ["docker", "Docker", "Tool", "container compose", `
# Docker
.docker/
docker-compose.override.yml
*.tar

# Environment files passed to containers
.env
*.env`],
    ["terraform", "Terraform", "Tool", "hcl iac infrastructure", `
# Local .terraform directories
.terraform/
*.tfstate
*.tfstate.*

# Crash logs
crash.log
crash.*.log

# Variable files often hold secrets
*.tfvars
*.tfvars.json

# Overrides
override.tf
override.tf.json
*_override.tf
*_override.tf.json

# CLI config
.terraformrc
terraform.rc
.terraform.lock.hcl.bak`],
    ["macos", "macOS", "OS", "mac apple finder", `
# macOS
.DS_Store
.AppleDouble
.LSOverride
._*
.DocumentRevisions-V100
.fseventsd
.Spotlight-V100
.TemporaryItems
.Trashes
.VolumeIcon.icns
.com.apple.timemachine.donotpresent
Icon?`],
    ["windows", "Windows", "OS", "explorer microsoft", `
# Windows
Thumbs.db
Thumbs.db:encryptable
ehthumbs.db
ehthumbs_vista.db
*.stackdump
[Dd]esktop.ini
$RECYCLE.BIN/
*.lnk`],
    ["linux", "Linux", "OS", "ubuntu unix", `
# Linux
*~
.fuse_hidden*
.directory
.Trash-*
.nfs*`],
    ["vscode", "VS Code", "Editor", "visual studio code editor", `
# VS Code: keep shared settings, ignore personal state
.vscode/*
!.vscode/settings.json
!.vscode/tasks.json
!.vscode/launch.json
!.vscode/extensions.json
!.vscode/*.code-snippets
.history/
*.vsix`],
    ["jetbrains", "JetBrains", "Editor", "intellij idea webstorm pycharm android studio rider", `
# JetBrains IDEs
.idea/
*.iml
*.ipr
*.iws
out/
.fleet/`],
    ["vim", "Vim", "Editor", "neovim nvim", `
# Vim
[._]*.s[a-v][a-z]
[._]*.sw[a-p]
[._]s[a-rt-v][a-z]
[._]ss[a-gi-z]
[._]sw[a-p]
Session.vim
Sessionx.vim
.netrwhist
*~
tags
[._]*.un~`]
];
export const BY: Record<string, Template> = {};
T.forEach((t) => (BY[t[0]] = t));

export function build(ids: string[], opt: { headers?: boolean; dedupe?: boolean; custom?: string } = {}) {
  const seen: Record<string, boolean> = Object.create(null), parts: string[] = [];
  let total = 0, dupes = 0;
  function section(title: string, body: string) {
    const lines = body.replace(/^\n+|\s+$/g, '').split('\n'), out: string[] = [];
    lines.forEach((l) => {
      const key = l.trim();
      if (key && key[0] !== '#') {
        if (opt.dedupe !== false && seen[key]) {
          dupes++;
          return;
        }
        seen[key] = true;
        total++;
      }
      if (!opt.headers && key[0] === '#') return;
      out.push(l);
    });
    // drop comment lines left without patterns under them, and doubled blank lines
    const clean: string[] = [];
    out.forEach((l, i) => {
      if (/^\s*#/.test(l)) {
        let j = i + 1;
        while (j < out.length && out[j].trim() && /^\s*#/.test(out[j])) j++;
        if (j >= out.length || !out[j].trim()) return;
      }
      if (!l.trim() && (!clean.length || !clean[clean.length - 1].trim())) return;
      clean.push(l);
    });
    while (clean.length && !clean[clean.length - 1].trim()) clean.pop();
    if (!clean.length) return;
    parts.push((opt.headers ? '### ' + title + ' ###\n' : '') + clean.join('\n'));
  }
  ids.forEach((id) => {
    if (BY[id]) section(BY[id][1], BY[id][4]);
  });
  if (opt.custom && opt.custom.trim()) section('Custom', opt.custom);
  const head =
    opt.headers && parts.length
      ? '# Generated with Gitignore Gen (https://s3eidat.github.io/gitignore-gen/)\n# Templates: ' +
        ids.map((id) => (BY[id] ? BY[id][1] : id)).join(', ') + (opt.custom && opt.custom.trim() ? ', Custom' : '') + '\n\n'
      : '';
  return { text: parts.length ? head + parts.join('\n\n') + '\n' : '', patterns: total, dupes };
}

/** Template id from an id, a display name or a keyword ("javascript" → node). */
export function resolve(q: string): string | null {
  const s = q.trim().toLowerCase();
  if (!s) return null;
  if (BY[s]) return s;
  const byName = T.find((t) => t[1].toLowerCase() === s);
  if (byName) return byName[0];
  const hay = (t: Template) => (t[1] + ' ' + t[0] + ' ' + t[3]).toLowerCase();
  const hit = T.find((t) => hay(t).split(/[\s/]+/).includes(s)) ?? T.find((t) => hay(t).indexOf(s) >= 0);
  return hit ? hit[0] : null;
}

export default defineTool({
  name: 'gitignore_generate',
  title: 'Generate .gitignore',
  webSlug: 'gitignore-gen',
  description:
    "Build a .gitignore by combining the website's templates for languages, frameworks, mobile, game engines, tools, OSes " +
    'and editors (' + T.map((t) => t[0]).join(', ') + '). Templates can be named by id, name or keyword ' +
    '(e.g. "javascript" → node). Duplicate patterns are removed, optional "### Name ###" section headers, plus your own ' +
    'custom lines at the end. Returns the text, or writes it to "output" (e.g. "./.gitignore"). Set "list" to see all ' +
    `templates. Web version: ${webUrl('gitignore-gen')}`,
  inputSchema: z.object({
    templates: z.array(z.string()).optional().default([]).describe('Templates to combine, in order, e.g. ["node", "nextjs", "vscode", "macos"].'),
    custom: z.string().optional().describe('Extra lines to append in a "Custom" section.'),
    headers: z.boolean().optional().default(true).describe('Add a generated-by header, section headers and template comments. Default true.'),
    dedupe: z.boolean().optional().default(true).describe('Drop patterns that already appeared in an earlier section. Default true.'),
    list: z.boolean().optional().default(false).describe('Just list the available templates (id, name, group, keywords).'),
    output: outputPath(),
  }),
  outputSchema: z.object({
    text: z.string().optional(),
    path: z.string().optional(),
    templates: z.array(z.string()).optional(),
    patterns: z.number().optional(),
    duplicatesRemoved: z.number().optional(),
    available: z.array(z.object({ id: z.string(), name: z.string(), group: z.string(), keywords: z.string() })).optional(),
  }),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  examples: [{ input: { templates: ['node', 'nextjs', 'vscode', 'macos'], custom: 'secrets/' } }, { input: { list: true } }],
  async run(input, ctx) {
    if (input.list) return { available: T.map((t) => ({ id: t[0], name: t[1], group: t[2], keywords: t[3] })) };
    const ids: string[] = [];
    for (const q of input.templates) {
      const id = resolve(q);
      if (!id) throw new ToolError(`Unknown template "${q}". Available: ${T.map((t) => t[0]).join(', ')}.`);
      if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length && !(input.custom && input.custom.trim())) throw new ToolError('Pick at least one template (or set "list" to see them).');
    const r = build(ids, { headers: input.headers, dedupe: input.dedupe, custom: input.custom });
    const out: Record<string, unknown> = { templates: ids, patterns: r.patterns, duplicatesRemoved: r.dupes };
    if (input.output) {
      // writeOutput's default names can't start with a dot, so name the file ourselves when given a folder.
      let target = input.output;
      const abs = await resolvePath(target, ctx, true);
      if (/[\\/]$/.test(target) || (existsSync(abs) && statSync(abs).isDirectory())) target = join(abs, '.gitignore');
      out.path = (await writeOutput(r.text, { output: target, defaultName: 'gitignore', mimeType: 'text/plain' }, ctx)).path;
    }
    else out.text = r.text;
    return out;
  },
});
