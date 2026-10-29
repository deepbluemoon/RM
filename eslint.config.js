// 루트 ESLint(T005) — backend·frontend·stub 공용. 백엔드는 console 대신 pino 만 쓴다
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'model-server/**', 'frontend/src/api/schema.d.ts', '**/*.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['backend/**/*.ts', 'tools/model-api-stub/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  ...vue.configs['flat/recommended'].map((c) => ({ ...c, files: ['frontend/**/*.vue'] })),
  {
    files: ['frontend/**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] }, globals: globals.browser },
    rules: { 'vue/multi-word-component-names': 'off', 'vue/max-attributes-per-line': 'off', 'vue/singleline-html-element-content-newline': 'off', 'vue/html-self-closing': 'off' },
  },
  { files: ['frontend/**/*.ts'], languageOptions: { globals: globals.browser } },
];
