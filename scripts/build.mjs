/**
 * Build pipeline for the 2FA Paster extension.
 *
 *   node scripts/build.mjs              assemble a loadable extension in dist/
 *   node scripts/build.mjs --watch      reassemble whenever a source file changes
 *   node scripts/build.mjs --zip        build, then write artifacts/2fa-paster-<version>.zip
 *   node scripts/build.mjs --clean-only remove dist/ and artifacts/
 *
 * The extension ships plain ES modules with no dependencies, so there is nothing
 * to transpile or bundle. This "build" is a copy plus one substitution, and it
 * exists for three reasons.
 *
 * 1. Consistency with the other extensions in this workspace: `npm run build`,
 *    then point chrome://extensions at `dist/`.
 *
 * 2. Credentials stay out of git. `oauth2.client_id` identifies *your* Google
 *    Cloud project, and the optional `key` pins the extension ID. Both are read
 *    from git-ignored files here and written into dist/manifest.json, so the
 *    committed manifest keeps its placeholder.
 *
 * 3. The store artifact cannot drift. `npm run zip` packages the exact dist/
 *    that was just assembled.
 *
 * The copy is an explicit allowlist rather than a glob, so tests, docs and this
 * script are never shipped. To stop that list from silently falling behind,
 * `verifyReferences()` reads the manifest, the HTML and the JS back out of dist/
 * and fails the build if anything they point at is missing.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createZip, verifyZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
const artifacts = path.join(root, 'artifacts');

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const cleanOnly = args.includes('--clean-only');
const zip = args.includes('--zip');

/** The value committed to manifest.json, replaced at build time when available. */
const CLIENT_ID_PLACEHOLDER = 'REPLACE_WITH_YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com';

/** Everything that belongs in a shipped extension, and nothing else. */
const RUNTIME_FILES = [
  'manifest.json',

  // Service worker and the injected filler.
  'background.js',
  'content.js',

  // Shared modules.
  'inbox-feed.js',
  'auth.js',
  'gmail.js',
  'text.js',
  'code-finder.js',
  'domains.js',
  'settings.js',

  // Clipboard writer: a service worker has no document to copy from.
  'offscreen.html',
  'offscreen.js',

  // Popup.
  'popup.html',
  'popup.css',
  'popup.js',

  // Setup and settings page.
  'options.html',
  'options.css',
  'options.js',

  // Icons.
  'icons/icon.svg',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
];

/** Trimmed contents of a git-ignored local credential file, or null. */
async function readLocal(name) {
  try {
    const value = (await readFile(path.join(root, name), 'utf8')).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function copyRuntime() {
  for (const file of RUNTIME_FILES) {
    const source = path.join(root, file);
    const target = path.join(out, file);
    let data;
    try {
      data = await readFile(source);
    } catch {
      throw new Error(`build: ${file} is listed in RUNTIME_FILES but does not exist`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/**
 * Write your OAuth client ID, and optionally your pinned extension key, into
 * the copy of the manifest in dist/.
 *
 * Neither is a secret in the "leaked password" sense, but both are specific to
 * one Cloud project and one installation, so they do not belong in a shared
 * repository. A missing client ID is a warning rather than an error: the
 * extension still loads and its setup page explains what to do, which is a
 * better first run than a build that refuses to produce anything.
 */
async function applyCredentials() {
  const manifestPath = path.join(out, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const clientId = process.env.GMAIL_CLIENT_ID?.trim() || (await readLocal('client-id.local'));
  if (clientId) {
    if (!clientId.endsWith('.apps.googleusercontent.com')) {
      throw new Error(
        `build: "${clientId}" does not look like a Google OAuth client ID ` +
          '(it should end in .apps.googleusercontent.com).',
      );
    }
    manifest.oauth2.client_id = clientId;
  }

  const key = await readLocal('extension-key.local');
  if (key) manifest.key = key.replace(/\s+/g, '');

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { configured: manifest.oauth2.client_id !== CLIENT_ID_PLACEHOLDER, pinnedKey: Boolean(key) };
}

/** Every file under `dir`, as forward-slash paths relative to it. */
async function collect(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collect(path.join(dir, entry.name), name)));
    else files.push({ name, data: await readFile(path.join(dir, entry.name)) });
  }
  return files;
}

/**
 * Cross-check the assembled extension against itself.
 *
 * The allowlist above is hand-written, which means it can fall behind a new
 * module. Rather than trust it, this reads the output back and resolves every
 * local reference it can find: manifest paths, `<script src>` and `<link href>`
 * in the HTML, and static or dynamic `import`s between the JS modules. Anything
 * unresolved fails the build, which is where you want to find out — not from a
 * blank popup after loading it in Chrome.
 */
async function verifyReferences(files) {
  const present = new Set(files.map((file) => file.name));
  const text = new Map(
    files
      .filter((file) => /\.(json|html|js|css)$/.test(file.name))
      .map((file) => [file.name, file.data.toString('utf8')]),
  );
  const problems = [];

  const require = (from, target) => {
    // Resolve relative to the referring file, then normalise to archive form.
    const resolved = path
      .posix
      .normalize(path.posix.join(path.posix.dirname(from), target))
      .replace(/^\.\//, '');
    if (!present.has(resolved)) problems.push(`${from} -> ${target}`);
  };

  const manifest = JSON.parse(text.get('manifest.json'));
  const manifestPaths = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      if (/\.(js|html|css|png|svg)$/.test(value) && !/^https?:/.test(value)) manifestPaths.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(manifest);
  for (const target of manifestPaths) require('manifest.json', target);

  for (const [name, source] of text) {
    if (name.endsWith('.html')) {
      for (const match of source.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)) {
        require(name, match[1]);
      }
    }
    if (name.endsWith('.js')) {
      // Static `from "./x.js"` and dynamic `import("./x.js")`.
      for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        require(name, match[1]);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `build: dist/ references files that are not in it:\n  ${problems.join('\n  ')}\n` +
        'Add them to RUNTIME_FILES in scripts/build.mjs.',
    );
  }
}

/**
 * Scripts that Chrome loads as classic scripts rather than modules.
 *
 * `content_scripts` and `scripting.executeScript` files are not modules, and
 * neither is a plain `<script src>` in an extension page.
 */
const CLASSIC_SCRIPTS = new Set(['content.js', 'offscreen.js']);

/**
 * Parse every script before shipping it.
 *
 * Worth the few hundred milliseconds because of where these errors surface. A
 * broken content script throws in the *page's* console, which nobody is looking
 * at, and the only symptom is that filling silently stops working. A broken
 * service worker shows up as an inert extension. Neither reaches a test run,
 * because nothing imports them.
 *
 * Classic files are parsed in-process; modules go through `node --check`, which
 * is the only way to get module syntax accepted.
 */
function verifyScripts(files) {
  const problems = [];

  for (const file of files.filter((entry) => entry.name.endsWith('.js'))) {
    const source = file.data.toString('utf8');

    if (CLASSIC_SCRIPTS.has(file.name)) {
      if (/^\s*(?:import|export)\s/m.test(source)) {
        problems.push(
          `${file.name}: uses import/export, but Chrome loads this one as a classic script`,
        );
        continue;
      }
      try {
        new Script(source, { filename: file.name });
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      }
      continue;
    }

    try {
      execFileSync(process.execPath, ['--check', path.join(root, file.name)], { stdio: 'pipe' });
    } catch (error) {
      const detail = String(error.stderr ?? error.message)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('at ') && !line.startsWith('Node.js v'))
        .slice(0, 2)
        .join(' — ');
      problems.push(`${file.name}: ${detail}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`build: these scripts do not parse:\n  ${problems.join('\n  ')}`);
  }
}

async function writeZip(version) {
  await mkdir(artifacts, { recursive: true });
  const archivePath = path.join(artifacts, `2fa-paster-${version}.zip`);
  const files = await collect(out);
  const bytes = createZip(files);
  await writeFile(archivePath, bytes);

  // Read it straight back: every entry is inflated and CRC-checked, so a
  // malformed archive fails here rather than at the Web Store upload.
  const entries = verifyZip(bytes);
  if (entries.length !== files.length) {
    throw new Error(`zip verification found ${entries.length} of ${files.length} entries`);
  }
  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('zip is missing manifest.json at the archive root');
  }

  console.log(
    `wrote ${path.relative(root, archivePath)} ` +
      `(${entries.length} files, ${(bytes.length / 1024).toFixed(1)} kB, verified)`,
  );
}

async function build() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await copyRuntime();
  const credentials = await applyCredentials();

  const files = await collect(out);
  await verifyReferences(files);
  verifyScripts(files);

  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) {
    throw new Error(
      `build: manifest.json is ${manifest.version} but package.json is ${pkg.version}. ` +
        'Keep them in step so the store artifact is named after what it contains.',
    );
  }

  const bytes = files.reduce((total, file) => total + file.data.length, 0);
  console.log(
    `build complete -> dist/  (${files.length} files, ${(bytes / 1024).toFixed(1)} kB, v${manifest.version})`,
  );

  if (!credentials.configured) {
    // Not a problem: the default reader is the Atom inbox feed, which needs no
    // credential at all. This only forecloses the optional full-message reader.
    console.log(
      '\nnote: no OAuth client ID was supplied, so the optional "full messages" reader is\n' +
        '      unavailable. The default inbox-preview reader does not need one and works as\n' +
        '      soon as you are signed in to Gmail. To enable full messages, put your client\n' +
        '      ID in client-id.local (or set GMAIL_CLIENT_ID) and build again.',
    );
  }
  return manifest.version;
}

async function main() {
  if (cleanOnly) {
    await rm(out, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
    console.log('cleaned dist/ and artifacts/');
    return;
  }

  const version = await build();
  if (zip) await writeZip(version);

  if (watchMode) {
    let queued = null;
    const rebuild = () => {
      clearTimeout(queued);
      // Editors save in bursts; one rebuild per burst is enough.
      queued = setTimeout(() => {
        build().catch((error) => console.error(error.message));
      }, 120);
    };
    for (const target of ['.', 'icons']) {
      watch(path.join(root, target), { persistent: true }, (_event, filename) => {
        if (filename && RUNTIME_FILES.some((file) => file.endsWith(filename))) rebuild();
      });
    }
    console.log('watching for changes... load dist/ in Chrome and press reload after each rebuild');
    return;
  }

  console.log('Load it via chrome://extensions -> Developer mode -> Load unpacked -> select dist/');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
