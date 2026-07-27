import { defineConfig } from 'oxlint';
import core from 'ultracite/oxlint/core';
import react from 'ultracite/oxlint/react';

// Ultracite ships its oxlint presets as ESM modules from 7.5 on, so the former
// .oxlintrc.json "extends" paths stopped resolving and the config moved here.
// oxlint loads a JS config through Node, which is why the lint scripts invoke
// it via node rather than bunx.
//
// core + react are the two presets this repo has always composed. The vitest
// preset is deliberately NOT extended: it applies through "overrides", which
// outrank anything declared here, and it lands 11,736 findings across the suite
// (require-top-level-describe, prefer-strict-equal, max-expects, ...). Those are
// test-authoring opinions, and prefer-strict-equal rewrites assertion semantics.
// Adopting them is a deliberate change, not a side effect of a Dependabot bump.
export default defineConfig({
  extends: [core, react],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    ...[
      '**/dist/**',
      '**/.expo/**',
      '**/node_modules/**',
      'apps/oauth-worker/worker-configuration.d.ts',
      'apps/web/src/generated/**',
      'packages/blueprints/automations/**',
      'packages/blueprints/visual-harness/mock-centraid.js',
    ],
  ],
  rules: {
    // Rules ultracite 7.9's presets newly enable. Issue #210 fixed this
    // repo's profile as correctness + suspicious + perf with explicit
    // opinions, so these are pinned off rather than silently adopted. The
    // count after each is what turning it back on would cost today, so a
    // family can be adopted on its own terms later.
    'import/default': 'off', // 1 sites
    'import/newline-after-import': 'off', // 8 sites
    'import/no-duplicates': 'off', // 3 sites
    'jsdoc/require-param-description': 'off', // 37 sites
    'jsdoc/require-returns-description': 'off', // 21 sites
    'jsdoc/require-yields-type': 'off', // 4 sites
    'jsx-a11y/click-events-have-key-events': 'off', // 41 sites
    'jsx-a11y/control-has-associated-label': 'off', // 7 sites
    'jsx-a11y/interactive-supports-focus': 'off', // 1 sites
    'jsx-a11y/label-has-associated-control': 'off', // 1 sites
    'jsx-a11y/media-has-caption': 'off', // 5 sites
    'jsx-a11y/no-aria-hidden-on-focusable': 'off', // 3 sites
    'jsx-a11y/no-noninteractive-element-interactions': 'off', // 2 sites
    'jsx-a11y/no-noninteractive-element-to-interactive-role': 'off', // 4 sites
    'jsx-a11y/no-static-element-interactions': 'off', // 40 sites
    'jsx-a11y/prefer-tag-over-role': 'off', // 91 sites
    'logical-assignment-operators': 'off', // 15 sites
    'max-classes-per-file': 'off', // 1 sites
    'no-await-in-loop': 'off', // 722 sites
    'no-control-regex': 'off', // 1 sites
    'no-duplicate-imports': 'off', // 3 sites
    'no-empty': 'off', // 5 sites
    'no-implicit-globals': 'off', // 27 sites
    'no-param-reassign': 'off', // 3 sites
    'no-unreachable-loop': 'off', // 8 sites
    'no-unused-expressions': 'off', // 2 sites
    'no-unused-vars': 'off', // 13 sites
    'no-useless-return': 'off', // 3 sites
    'no-var': 'off', // 100 sites
    'node/callback-return': 'off', // 30 sites
    'object-shorthand': 'off', // 27 sites
    'oxc/branches-sharing-code': 'off', // 8 sites
    'prefer-arrow-callback': 'off', // 70 sites
    'prefer-named-capture-group': 'off', // 399 sites
    'promise/no-callback-in-promise': 'off', // 2 sites
    'promise/param-names': 'off', // 1 sites
    'promise/prefer-catch': 'off', // 5 sites
    'react-hooks/exhaustive-deps': 'off', // 1 sites
    'react/hook-use-state': 'off', // 5 sites
    'react/iframe-missing-sandbox': 'off', // 2 sites
    'react/jsx-fragments': 'off', // 1 sites
    'react/jsx-handler-names': 'off', // 92 sites
    'react/no-object-type-as-default-prop': 'off', // 2 sites
    'react/no-unstable-nested-components': 'off', // 3 sites
    'react/react-compiler': 'off', // 263 sites
    'react/self-closing-comp': 'off', // 38 sites
    'require-unicode-regexp': 'off', // 1889 sites
    'typescript/method-signature-style': 'off', // 541 sites
    'typescript/prefer-for-of': 'off', // 1 sites
    'unicorn/consistent-date-clone': 'off', // 2 sites
    'unicorn/import-style': 'off', // 34 sites
    'unicorn/no-anonymous-default-export': 'off', // 132 sites
    'unicorn/no-negated-condition': 'off', // 804 sites
    'unicorn/no-useless-collection-argument': 'off', // 1 sites
    'unicorn/no-useless-spread': 'off', // 3 sites
    'unicorn/prefer-add-event-listener': 'off', // 6 sites
    'unicorn/prefer-array-find': 'off', // 1 sites
    'unicorn/prefer-default-parameters': 'off', // 1 sites
    'unicorn/prefer-dom-node-dataset': 'off', // 17 sites
    'unicorn/prefer-export-from': 'off', // 26 sites
    'unicorn/prefer-import-meta-properties': 'off', // 95 sites
    'unicorn/prefer-includes': 'off', // 2 sites
    'unicorn/prefer-number-coercion': 'off', // 52 sites
    'unicorn/prefer-optional-catch-binding': 'off', // 5 sites
    'unicorn/prefer-query-selector': 'off', // 28 sites
    'unicorn/prefer-single-call': 'off', // 30 sites
    'unicorn/require-post-message-target-origin': 'off', // 3 sites
    'vars-on-top': 'off', // 65 sites

    // Repo profile (#210).
    'arrow-body-style': 'off',
    'class-methods-use-this': 'off',
    complexity: 'off',
    curly: 'off',
    'default-case': 'off',
    eqeqeq: 'off',
    'func-names': 'off',
    'func-style': 'off',
    'import/consistent-type-specifier-style': 'off',
    'max-lines': 'off',
    'no-accumulating-spread': 'off',
    'no-alert': 'off',
    'no-bitwise': 'off',
    'no-console': 'off',
    'no-else-return': 'off',
    'no-empty-function': 'off',
    'no-eq-null': 'off',
    'no-inline-comments': 'off',
    'no-lonely-if': 'off',
    'no-loop-func': 'off',
    'no-negated-condition': 'off',
    'no-nested-ternary': 'off',
    'no-plusplus': 'off',
    'no-promise-executor-return': 'off',
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@centraid/*/src/*', '@centraid/*/dist/*'],
            message:
              "Import from the package root barrel (e.g. '@centraid/app-engine'), not its internals \u2014 keeps each package's public surface the real contract. See governance: no-deep-imports.",
          },
        ],
      },
    ],
    'no-shadow': 'off',
    'no-throw-literal': 'off',
    'no-unmodified-loop-condition': 'off',
    'no-use-before-define': 'off',
    'no-useless-constructor': 'off',
    'no-void': 'off',
    'no-warning-comments': 'off',
    'prefer-const': 'off',
    'prefer-destructuring': 'off',
    'prefer-object-spread': 'off',
    'prefer-template': 'off',
    'promise/avoid-new': 'off',
    'promise/no-nesting': 'off',
    'promise/no-promise-in-callback': 'off',
    'promise/prefer-await-to-callbacks': 'off',
    'promise/prefer-await-to-then': 'off',
    'react-perf/jsx-no-new-function-as-prop': 'off',
    'react/exhaustive-deps': 'warn',
    'react/jsx-curly-brace-presence': 'off',
    'react/jsx-no-constructed-context-values': 'off',
    'react/jsx-no-useless-fragment': 'off',
    'react/no-array-index-key': 'off',
    'react/no-danger': 'off',
    'react/no-unescaped-entities': 'off',
    'react/rules-of-hooks': 'error',
    'react/style-prop-object': 'off',
    'require-await': 'off',
    'sort-keys': 'off',
    'typescript/array-type': 'off',
    'typescript/ban-ts-comment': 'error',
    'typescript/consistent-type-definitions': 'off',
    'typescript/consistent-type-imports': 'off',
    'typescript/no-dynamic-delete': 'off',
    'typescript/no-empty-interface': 'off',
    'typescript/no-empty-object-type': 'off',
    'typescript/no-explicit-any': 'error',
    'typescript/no-import-type-side-effects': 'off',
    'typescript/no-inferrable-types': 'off',
    'typescript/no-invalid-void-type': 'off',
    'typescript/no-non-null-assertion': 'off',
    'typescript/parameter-properties': 'off',
    'unicorn/catch-error-name': 'off',
    'unicorn/consistent-existence-index-check': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/filename-case': 'off',
    'unicorn/no-array-for-each': 'off',
    'unicorn/no-array-reduce': 'off',
    'unicorn/no-array-sort': 'off',
    'unicorn/no-await-expression-member': 'off',
    'unicorn/no-hex-escape': 'off',
    'unicorn/no-immediate-mutation': 'off',
    'unicorn/no-lonely-if': 'off',
    'unicorn/no-nested-ternary': 'off',
    'unicorn/no-object-as-default-parameter': 'off',
    'unicorn/no-typeof-undefined': 'off',
    'unicorn/no-useless-undefined': 'off',
    'unicorn/number-literal-case': 'off',
    'unicorn/numeric-separators-style': 'off',
    'unicorn/prefer-at': 'off',
    'unicorn/prefer-code-point': 'off',
    'unicorn/prefer-dom-node-append': 'off',
    'unicorn/prefer-logical-operator-over-ternary': 'off',
    'unicorn/prefer-math-min-max': 'off',
    'unicorn/prefer-math-trunc': 'off',
    'unicorn/prefer-module': 'off',
    'unicorn/prefer-negative-index': 'off',
    'unicorn/prefer-number-properties': 'off',
    'unicorn/prefer-response-static-json': 'off',
    'unicorn/prefer-set-has': 'off',
    'unicorn/prefer-spread': 'off',
    'unicorn/prefer-string-replace-all': 'off',
    'unicorn/prefer-string-slice': 'off',
    'unicorn/prefer-ternary': 'off',
    'unicorn/prefer-type-error': 'off',
    'unicorn/switch-case-braces': 'off',
    'unicorn/text-encoding-identifier-case': 'off',
  },
  overrides: [
    {
      files: ['packages/app-engine/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@centraid/*'],
                message:
                  'app-engine is the stable core of the dependency DAG \u2014 it must not import other @centraid packages. Mode/runtime specifics belong at entrypoints (desktop main, gateway CLI). See governance: module-layering.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/automation/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: [
                  '@centraid/agent-runtime',
                  '@centraid/agent-runtime/*',
                  '@centraid/gateway',
                  '@centraid/gateway/*',
                ],
                message:
                  'automation must not depend on an agent backend \u2014 execution and scheduling are injected callbacks (it depends on app-engine, never on agent-runtime/gateway). See governance: module-layering.',
              },
              {
                group: ['@centraid/*/src/*', '@centraid/*/dist/*'],
                message:
                  'Import from the package root barrel, not its internals. See governance: no-deep-imports.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['packages/blueprints/kit/**', 'packages/blueprints/apps/**'],
      rules: {
        'typescript/no-explicit-any': 'off',
      },
    },
  ],
});
