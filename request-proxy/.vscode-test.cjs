const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig({
    files: 'out/test/**/*.test.js',
    mocha: {
        ui: 'bdd',
        // Keep parity with launch.json to avoid test runner timeouts.
        timeout: 120000
    },
    launchArgs: [
        // Prevent other extensions from activating during tests.
        '--disable-extensions'
    ]
});
