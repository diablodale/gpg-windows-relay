/**
 * Mocha entry point for Phase 1 integration tests.
 *
 * Loaded by @vscode/test-electron as extensionTestsPath. Must export run().
 * Globs for *.test.js files in the parent directory (out/test/integration/).
 *
 * Timeout is set high (60 s) because real gpg-agent operations (key generation,
 * signing) are significantly slower than unit test mocks.
 */

import * as path from 'path';
import Mocha = require('mocha');
import { glob } from 'glob';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 60000   // 60 s — real gpg operations are slow
    });

    // __dirname = out/test/integration/suite/ at runtime; go up one level to find test files.
    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((resolve, reject) => {
        glob('**/*.test.js', { cwd: testsRoot })
            .then(files => {
                files.forEach(file => {
                    mocha.addFile(path.resolve(testsRoot, file));
                });

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
            })
            .catch(err => {
                reject(err);
            });
    });
}
