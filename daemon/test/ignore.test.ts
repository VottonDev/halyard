import { describe, expect, test } from 'bun:test';

import { LEGACY_TRASH_DIR_NAME, PARTIAL_DOWNLOAD_SUFFIX } from '../src/config.js';
import { isIgnoredName } from '../src/engine/localScan.js';

describe('scanner ignore rules', () => {
    test('ignores our own in-progress download files', () => {
        // Regression: the partial suffix did not actually match the ignore
        // list, so a scan racing a download would upload the half-written
        // temporary file to Drive as though it were real content.
        expect(isIgnoredName(`report.pdf${PARTIAL_DOWNLOAD_SUFFIX}`)).toBe(true);
        expect(isIgnoredName(`archive.tar.gz${PARTIAL_DOWNLOAD_SUFFIX}`)).toBe(true);
        expect(isIgnoredName(PARTIAL_DOWNLOAD_SUFFIX)).toBe(true);
    });

    test('still ignores the legacy trash folder left by older versions', () => {
        // Deletions are applied directly now, but an existing quarantine
        // folder must not suddenly be uploaded as new content.
        expect(isIgnoredName(LEGACY_TRASH_DIR_NAME)).toBe(true);
    });

    test('ignores editor scratch files', () => {
        for (const name of [
            'notes.txt~',
            '.notes.txt.swp',
            'download.crdownload',
            'thing.partial',
            'build.tmp',
            '.~lock.document.odt#',
            '.goutputstream-A1B2C3',
        ]) {
            expect(isIgnoredName(name)).toBe(true);
        }
    });

    test('does not ignore ordinary files', () => {
        for (const name of [
            'report.pdf',
            'notes.md',
            'archive.tar.gz',
            '.bashrc',
            'my.partial.report.docx',
            'a (conflict 2026-07-19).txt',
        ]) {
            expect(isIgnoredName(name)).toBe(false);
        }
    });
});
