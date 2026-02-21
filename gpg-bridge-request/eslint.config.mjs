import tseslint from 'typescript-eslint';

export default [
    {
        ignores: ['out/**', 'node_modules/**']
    },
    {
        files: ['**/*.ts'],
        plugins: {
            '@typescript-eslint': tseslint.plugin
        },
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                sourceType: 'module'
            }
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'warn'
        }
    }
];
