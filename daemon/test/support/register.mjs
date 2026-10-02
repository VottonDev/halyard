/**
 * Lets Node's test runner import the daemon's sources directly.
 *
 * The `src/` tree imports with `.js` specifiers, which is what TypeScript and
 * the esbuild bundle require. Node strips types happily but does not rewrite
 * those specifiers to the `.ts` files that actually exist, so every relative
 * import fails. This hook does the rewrite, falling back to the original
 * specifier so real `.js` files still resolve.
 *
 * Used for `node:sqlite` tests (unsupported by Bun) and photo transfers
 * that verify the Node stream and file descriptor behaviour used at runtime.
 */
import { registerHooks } from 'node:module';

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
});
