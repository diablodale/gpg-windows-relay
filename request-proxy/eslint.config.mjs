import tseslint from 'typescript-eslint';

export default [
    {
        ignores: ['out/**', 'node_modules/**']
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                sourceType: 'module'
            }
        }
    }
];
