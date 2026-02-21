/**
 * Mocha entry point for Phase 2 integration tests.
 *
 * Loaded by @vscode/test-electron as extensionTestsPath. Must export run().
 * Loads requestProxyIntegration.test.js explicitly rather than globbing so
 * that Phase 3 test files added to the same output directory are not
 * accidentally picked up when Phase 2 runs in a container without gpg.
 *
 * Timeout is set high (60 s) because real gpg-agent operations (signs, round-trips)
 * through the full proxy chain are slower than unit test mocks.
 */

import * as path from 'path';
import Mocha = require('mocha');

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 60000   // 60 s — real gpg operations through the proxy chain are slow
    });

    // __dirname = out/test/integration/suite/ at runtime; go up one level to find test files.
    const testsRoot = path.resolve(__dirname, '..');
    mocha.addFile(path.join(testsRoot, 'requestProxyIntegration.test.js'));

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
