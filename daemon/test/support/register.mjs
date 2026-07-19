/**
 * Lets Node's test runner import the daemon's sources directly.
 *
 * The `src/` tree imports with `.js` specifiers, which is what TypeScript and
 * the esbuild bundle require. Node strips types happily but does not rewrite
 * those specifiers to the `.ts` files that actually exist, so every relative
 * import fails. This hook does the rewrite, falling back to the original
 * specifier so real `.js` files still resolve.
 *
 * Only needed for tests that touch `node:sqlite`, which Bun does not
 * implement — everything else runs under `bun test`.
 */
import { registerHooks } from 'node:module';

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
            try {
                return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
            } catch {
                // No sibling .ts — it really was a JavaScript file.
            }
        }
        return nextResolve(specifier, context);
    },
});
