const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig({
    // Integration tests live in out/test/integration/ and run only via `npm run test:integration`.
    // Use a non-recursive glob so only unit test files at the top of out/test/ are included.
    files: 'out/test/*.test.js',
    mocha: {
        ui: 'bdd',
        // Keep parity with launch.json to avoid test runner timeouts.
        timeout: 120000
    },
    launchArgs: [
        // Prevent other extensions from activating during tests.
        '--disable-extensions'
    ],
    // Skip extension dependencies install of agent-proxy during request-proxy unit tests.
    skipExtensionDependencies: true
});
