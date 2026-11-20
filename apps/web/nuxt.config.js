import { defineNuxtConfig } from 'nuxt/config'
import shopTheme from './app/themes/shop.js'

export default defineNuxtConfig({
  compatibilityDate: '2026-11-17',
  devtools: { enabled: false },
  modules: ['@primevue/nuxt-module'],
  css: [
    '@fontsource/poppins/400.css',
    '@fontsource/poppins/500.css',
    '@fontsource/poppins/600.css',
    '@fontsource/poppins/700.css',
    '~/assets/base.css',
    'primeicons/primeicons.css',
  ],
  primevue: {
    options: {
      ripple: true,
      theme: shopTheme,
    },
    components: {
      include: [
        'Button',
        'Checkbox',
        'Column',
        'DataTable',
        'DatePicker',
        'InputText',
        'Menu',
        'Paginator',
        'Select',
        'Tag',
      ],
    },
    directives: {
      include: [],
    },
    composables: {
      include: [],
    },
  },
  app: {
    head: {
      title: 'Sklep',
    },
  },
  runtimeConfig: {
    public: {
      apiBase: 'http://localhost:3001/api/v1',
    },
  },
})
