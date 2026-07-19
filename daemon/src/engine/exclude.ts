/**
 * Per-pair exclusion patterns.
 *
 * Lets a pair cover a broad folder while leaving parts of it alone — sync
 * `~/Documents` but not the `GitHub` checkout inside it.
 *
 * The syntax is a deliberate subset of gitignore, because that is what people
 * already know:
 *
 *   GitHub            a segment named GitHub at any depth, and everything under it
 *   /GitHub           only at the top level of the pair
 *   build/            trailing slash is accepted and ignored (folders and their
 *                     contents are excluded either way)
 *   *.iso             glob within one path segment
 *   **\/node_modules  explicit any-depth match
 *   # comment         ignored
 *
 * Negation (`!pattern`) is deliberately NOT supported: re-including a subset of
 * an excluded tree makes the "is this path excluded" question order-dependent,
 * and order-dependent answers are how sync tools end up deleting things.
 */

export type ExcludeMatcher = (relativePath: string) => boolean;

function escapeLiteral(text: string): string {
    return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Converts one pattern to a regular expression.
 *
 * `**` spans separators, `*` and `?` do not — the usual glob distinction, and
 * the reason the two cannot simply be replaced with `.*`.
 */
function compilePattern(rawPattern: string): RegExp | null {
    let pattern = rawPattern.trim();
    if (!pattern || pattern.startsWith('#')) {
        return null;
    }

    // Trailing slash only signals "directory", which is already implied.
    pattern = pattern.replace(/\/+$/, '');
    if (!pattern) {
        return null;
    }

    let anchored = false;
    if (pattern.startsWith('/')) {
        anchored = true;
        pattern = pattern.slice(1);
    } else if (pattern.includes('/')) {
        // A pattern with an interior slash describes a path, so it is anchored
        // to the pair root, matching gitignore.
        anchored = true;
    }
    if (!pattern) {
        return null;
    }

    let expression = '';
    for (let index = 0; index < pattern.length; index++) {
        const character = pattern[index];
        if (character === '*') {
            if (pattern[index + 1] === '*') {
                index++;
                // Consume a following slash so `**/x` also matches a bare `x`.
                if (pattern[index + 1] === '/') {
                    index++;
                    expression += '(?:.*/)?';
                } else {
                    expression += '.*';
                }
            } else {
                expression += '[^/]*';
            }
        } else if (character === '?') {
            expression += '[^/]';
        } else if (character === '/') {
            expression += '/';
        } else {
            expression += escapeLiteral(character);
        }
    }

    // Match the path itself and, because excluding a folder excludes its
    // contents, anything beneath it.
    const body = anchored ? `^${expression}` : `^(?:.*/)?${expression}`;
    return new RegExp(`${body}(?:/.*)?$`);
}

export function compileExcludes(patterns: readonly string[]): ExcludeMatcher {
    const expressions = patterns.map(compilePattern).filter((value): value is RegExp => value !== null);

    if (expressions.length === 0) {
        return () => false;
    }
    return (relativePath: string) => expressions.some((expression) => expression.test(relativePath));
}

/**
 * Reports a pattern as invalid rather than silently ignoring it, so the UI can
 * tell the user their exclusion will not do anything.
 */
export function validatePattern(rawPattern: string): string | null {
    const pattern = rawPattern.trim();
    if (!pattern || pattern.startsWith('#')) {
        return null;
    }
    if (pattern.startsWith('!')) {
        return 'Negated patterns (!) are not supported';
    }
    if (pattern.includes('\\')) {
        return 'Use forward slashes';
    }
    if (/^\/+$/.test(pattern) || pattern.replace(/\/+$/, '') === '') {
        return 'Pattern is empty';
    }
    if (pattern.startsWith('../') || pattern.includes('/../')) {
        return 'Patterns are relative to the folder and cannot escape it';
    }
    try {
        compilePattern(pattern);
    } catch {
        return 'Pattern could not be understood';
    }
    return null;
}

/**
 * Removes excluded paths from a path-keyed map.
 *
 * This must be applied to the local snapshot, the remote snapshot AND the
 * recorded base together. Filtering only one of them is the trap: drop the
 * local side alone and the reconciler sees files that exist in the base and
 * remotely but not locally, concludes they were deleted, and trashes them on
 * Drive. Excluding a folder must mean "ignore entirely", never "delete".
 */
export function filterExcluded<T>(entries: Map<string, T>, isExcluded: ExcludeMatcher): Map<string, T> {
    const kept = new Map<string, T>();
    for (const [key, value] of entries) {
        if (!isExcluded(key)) {
            kept.set(key, value);
        }
    }
    return kept;
}
