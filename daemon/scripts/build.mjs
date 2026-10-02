// Bundles the daemon into a single CommonJS file.
//
// Bundling is not optional here: @protontech/crypto and proton-drive-sdk-account
// both publish raw TypeScript (crypto's package exports point straight at .ts
// files), so Node cannot load them directly. esbuild transpiles them for us.
//
// preserveSymlinks matters because the Proton SDK packages are linked in via
// `file:` deps. Without it, esbuild resolves their imports from the SDK's real
// path in ../proton-sdk, where our node_modules tree does not exist.

import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const entryArg = process.argv.find((arg) => arg.startsWith('--entry='));
const entry = entryArg ? entryArg.slice('--entry='.length) : 'src/main.ts';
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const out = outArg ? outArg.slice('--out='.length) : 'dist/halyard-daemon.cjs';
const metafileArg = process.argv.find((arg) => arg.startsWith('--metafile='));
const metafile = metafileArg?.slice('--metafile='.length);

/** @type {import('esbuild').BuildOptions} */
const options = {
    absWorkingDir: root,
    entryPoints: [path.join(root, entry)],
    outfile: path.join(root, out),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    preserveSymlinks: true,
    sourcemap: true,
    logLevel: 'info',
    metafile: Boolean(metafile),
    // Node builtins are external automatically; nothing else should be.
    external: [],
    alias: {
        // Optional X11-only dependency of dbus-next that we never reach.
        x11: path.join(root, 'scripts/stubs/x11-unavailable.cjs'),
    },
    define: {
        // openpgp calls createRequire(import.meta.url) internally. That is
        // undefined once bundled to CJS, so point it at this bundle's own path.
        'import.meta.url': '__halyardModuleUrl',
    },
    banner: {
        js: "const __halyardModuleUrl = require('node:url').pathToFileURL(__filename).href;",
    },
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[build] watching…');
} else {
    const result = await esbuild.build(options);
    if (metafile) await writeFile(path.resolve(root, metafile), JSON.stringify(result.metafile));
    console.log(`[build] wrote ${out}`);
}
