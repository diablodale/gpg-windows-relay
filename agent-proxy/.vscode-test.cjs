const { defineConfig } = require('@vscode/test-cli');

module.exports = defineConfig({
    files: 'out/agent-proxy/src/test/**/*.test.js',
    mocha: {
        ui: 'bdd'
    }
});
