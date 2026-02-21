import * as path from 'path';
import Mocha = require('mocha');
import { glob } from 'glob';

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'bdd',
        color: true,
        timeout: 120000
    });

    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((resolve, reject) => {
        glob('**/*.test.js', { cwd: testsRoot, ignore: ['integration/**'] })
            .then(files => {
                files.forEach(file => {
                    mocha.addFile(path.resolve(testsRoot, file));
                });

                try {
                    mocha.run((failures: number) => {
                        if (failures > 0) {
                            reject(new Error(`${failures} tests failed.`));
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
