/**
 * Lets Node's test runner import the daemon's sources directly.
 *
 * The `src/` tree imports with `.js` specifiers, which is what TypeScript and
 * the esbuild bundle require. This hook rewrites those specifiers to `.ts`,
 * falling back to the original so real `.js` files still resolve. It also uses
 * esbuild to erase types: distro Node packages can omit native type stripping
 * even when their version supports it. The tests still run under Node.
 *
 * Used for `node:sqlite` tests (unsupported by Bun) and photo transfers
 * that verify the Node stream and file descriptor behaviour used at runtime.
 */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
            try {
                return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
            } catch {
                // No sibling .ts exists, so this was a JavaScript file.
            }
        }
        return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
        if (url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
            const filename = fileURLToPath(url);
            const result = transformSync(readFileSync(filename, 'utf8'), {
                loader: 'ts', format: 'esm', target: 'node22',
                sourcefile: filename, sourcemap: 'inline',
            });
            return { format: 'module', source: result.code, shortCircuit: true };
        }
        return nextLoad(url, context);
    },
});
