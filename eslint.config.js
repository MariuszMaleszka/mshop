import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/.nitro/**',
      '**/dist/**',
      '**/coverage/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{js,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        useRuntimeConfig: 'readonly',
        useApi: 'readonly',
        useHead: 'readonly',
        useRoute: 'readonly',
        useRequestURL: 'readonly',
        definePageMeta: 'readonly',
        defineEventHandler: 'readonly',
        getRequestHeader: 'readonly',
        setCookie: 'readonly',
        deleteCookie: 'readonly',
        readBody: 'readonly',
        setResponseHeader: 'readonly',
        setResponseStatus: 'readonly',
        getQuery: 'readonly',
        getRouterParam: 'readonly',
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
    },
  },
]
