/**
 * Mocha entry point for Phase 3 integration tests.
 *
 * Loaded by @vscode/test-electron as extensionTestsPath. Must export run().
 * Loads gpgCliIntegration.test.js explicitly rather than globbing so that
 * Phase 2 test files in the same output directory are not accidentally loaded
 * (Phase 3's container has gnupg2; Phase 2's does not need it, but the reverse
 * isolation — preventing phase3 from running in phase2's container — is the
 * primary concern. See suite/index.ts for the symmetric note from the other side).
 *
 * Timeout is 120 s: sign/decrypt operations go through the full proxy chain
 * (gpg → Unix socket → request-proxy → VS Code commands → agent-proxy → gpg-agent).
 * Large-file encrypt+decrypt (256 KB binary, PKDECRYPT) is the slowest case.
 */

import * as path from 'path';
import Mocha = require('mocha');

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 120000   // 120 s — full chain crypto ops + 1 MB sign stress test
    });

    // __dirname = out/test/integration/suite/ at runtime; go up one level to find test files.
    const testsRoot = path.resolve(__dirname, '..');
    mocha.addFile(path.join(testsRoot, 'gpgCliIntegration.test.js'));

    return new Promise((resolve, reject) => {
        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} integration test(s) failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}
