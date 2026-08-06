import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import promise from 'eslint-plugin-promise';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';

const strictRules = {
  'array-callback-return': ['error', { checkForEach: true }],
  'block-scoped-var': 'error',
  'consistent-return': 'error',
  curly: ['error', 'all'],
  'default-case-last': 'error',
  'default-param-last': 'error',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'grouped-accessor-pairs': ['error', 'getBeforeSet'],
  'max-depth': ['error', 5],
  'max-params': ['error', 6],
  'no-alert': 'error',
  'no-caller': 'error',
  'no-constructor-return': 'error',
  'no-else-return': ['error', { allowElseIf: false }],
  'no-eval': 'error',
  'no-extend-native': 'error',
  'no-extra-bind': 'error',
  'no-implicit-coercion': ['error', { boolean: false }],
  'no-implicit-globals': 'error',
  'no-implied-eval': 'error',
  'no-invalid-this': 'error',
  'no-iterator': 'error',
  'no-labels': ['error', { allowLoop: false, allowSwitch: false }],
  'no-lone-blocks': 'error',
  'no-loop-func': 'error',
  'no-multi-str': 'error',
  'no-new-func': 'error',
  'no-new-wrappers': 'error',
  'no-object-constructor': 'error',
  'no-octal-escape': 'error',
  'no-param-reassign': ['error', { props: false }],
  'no-promise-executor-return': 'error',
  'no-proto': 'error',
  'no-return-assign': ['error', 'always'],
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "ChainExpression > CallExpression[optional=true][callee.type='Identifier'][callee.name=/^on[A-Z]/]",
      message:
        'UI callbacks must be required contracts. Invoke them directly so missing wiring fails immediately.',
    },
  ],
  'no-script-url': 'error',
  'no-self-compare': 'error',
  'no-sequences': 'error',
  'no-shadow': ['error', { builtinGlobals: false, hoist: 'all' }],
  'no-throw-literal': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unneeded-ternary': 'error',
  'no-unused-expressions': 'error',
  'no-unused-vars': [
    'error',
    {
      args: 'after-used',
      caughtErrors: 'all',
      ignoreRestSiblings: false,
      reportUsedIgnorePattern: true,
    },
  ],
  'no-use-before-define': [
    'error',
    { functions: false, classes: true, variables: true, allowNamedExports: false },
  ],
  'no-useless-call': 'error',
  'no-useless-catch': 'error',
  'no-useless-computed-key': 'error',
  'no-useless-concat': 'error',
  'no-useless-rename': 'error',
  'no-useless-return': 'error',
  'no-var': 'error',
  'no-warning-comments': [
    'error',
    { terms: ['todo', 'fixme', 'xxx'], location: 'anywhere', decoration: ['*'] },
  ],
  'object-shorthand': ['error', 'always'],
  'prefer-arrow-callback': ['error', { allowNamedFunctions: false }],
  'prefer-const': ['error', { destructuring: 'all' }],
  'prefer-object-has-own': 'error',
  'prefer-promise-reject-errors': ['error', { allowEmptyReject: false }],
  'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
  'preserve-caught-error': ['error', { requireCatchParameter: true }],
  radix: 'error',
  'require-await': 'error',
  'symbol-description': 'error',
  yoda: ['error', 'never'],
};

export default defineConfig([
  globalIgnores(['artifacts', 'dist', 'node_modules', 'playwright-report', 'src/assets', 'test-results']),
  {
    name: 'hol/strict-javascript',
    files: ['**/*.{js,jsx,mjs}'],
    extends: [js.configs.recommended, promise.configs['flat/recommended']],
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    languageOptions: {
      ecmaVersion: 'latest',
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      ...strictRules,
      'promise/always-return': 'off',
      'promise/catch-or-return': ['error', { allowFinally: true, allowThen: true }],
      'promise/no-callback-in-promise': 'error',
      'promise/no-nesting': 'off',
      'promise/no-promise-in-callback': 'error',
      'promise/no-return-in-finally': 'error',
      'promise/param-names': [
        'error',
        {
          resolvePattern: '^(?:_|_?resolve(?:[A-Z][A-Za-z0-9]*)?)$',
          rejectPattern: '^_?reject(?:[A-Z][A-Za-z0-9]*)?$',
        },
      ],
      'promise/valid-params': 'error',
    },
  },
  {
    name: 'hol/browser-runtime',
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/**/*.test.js', 'src/**/*.unit.test.js', 'src/**/*.worker.js'],
    extends: [reactHooks.configs.flat['recommended-latest'], reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-console': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    name: 'hol/browser-logger-adapter',
    files: ['src/utils/logger.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    name: 'hol/web-workers',
    files: ['src/**/*.worker.js'],
    languageOptions: {
      globals: globals.worker,
    },
  },
  {
    name: 'hol/opencv-classic-runtime-adapter',
    files: ['src/cv/opencv.workerRuntime.js'],
    rules: {
      'no-new-func': 'off',
    },
  },
  {
    name: 'hol/service-worker',
    files: ['public/sw.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    name: 'hol/node-runtime',
    files: ['*.config.js', 'eslint.config.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    name: 'hol/test-runtime',
    files: ['src/**/*.test.js', 'src/**/*.unit.test.js', 'tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'max-params': 'off',
      'require-await': 'off',
    },
  },
  prettierConfig,
]);
