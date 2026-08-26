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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const entryArg = process.argv.find((arg) => arg.startsWith('--entry='));
const entry = entryArg ? entryArg.slice('--entry='.length) : 'src/main.ts';
const outArg = process.argv.find((arg) => arg.startsWith('--out='));
const out = outArg ? outArg.slice('--out='.length) : 'dist/halyard-daemon.cjs';

/** @type {import('esbuild').BuildOptions} */
const options = {
    entryPoints: [path.join(root, entry)],
    outfile: path.join(root, out),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    preserveSymlinks: true,
    sourcemap: true,
    logLevel: 'info',
    // Node builtins are external automatically; nothing else should be.
    external: [],
    alias: {
        // Optional X11-only dependency of dbus-next that we never reach.
        x11: path.join(root, 'scripts/stubs/x11-unavailable.cjs'),
    },
    define: {
        'process.env.HALYARD_VERSION': JSON.stringify(process.env.HALYARD_VERSION ?? '0.1.3'),
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
    await esbuild.build(options);
    console.log(`[build] wrote ${out}`);
}
