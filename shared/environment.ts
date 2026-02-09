export function isTestEnvironment(): boolean {
    const argv = process.argv.join(' ');

    return process.env.npm_lifecycle_event === 'test'
        || process.env.VSCODE_TEST_MODE === '1'
        || argv.includes('extensionTestsPath')
        || argv.includes('vscode-test')
        || argv.includes('bootstrap-fork.js');
}
