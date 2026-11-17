import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  compatibilityDate: '2026-11-17',
  devtools: { enabled: false },
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
