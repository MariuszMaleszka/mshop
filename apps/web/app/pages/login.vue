<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import {
  bootstrapLoginCsrf,
  submitAccountLogin,
} from '../modules/account-login/bff.js'
import { clearLoginCsrf } from '../modules/account-login/csrf-memory.js'
import { validateLoginForm } from '../modules/account-login/form.js'
import { LOGIN_MESSAGES } from '../modules/account-login/messages.js'

definePageMeta({ layout: 'shop' })

const pageOrigin = useRequestURL().origin
const email = ref('')
const password = ref('')
const fieldErrors = ref({})
const errorMessage = ref('')
const ready = ref(false)
const submitting = ref(false)

onMounted(() => {
  prepareChallenge()
})

onUnmounted(() => {
  clearLoginCsrf()
})

async function prepareChallenge() {
  ready.value = false
  errorMessage.value = ''
  const result = await bootstrapLoginCsrf(pageOrigin)

  if (!result.ok) {
    errorMessage.value = result.message
    return
  }

  ready.value = true
}

async function submitForm() {
  if (submitting.value) {
    return
  }

  errorMessage.value = ''
  fieldErrors.value = {}

  const validated = validateLoginForm({
    email: email.value,
    password: password.value,
  })

  if (!validated.ok) {
    fieldErrors.value = validated.fields
    return
  }

  if (!ready.value) {
    errorMessage.value = LOGIN_MESSAGES.formExpired
    return
  }

  submitting.value = true
  const result = await submitAccountLogin(pageOrigin, {
    email: validated.email,
    password: validated.password,
  })

  if (!result.ok) {
    password.value = ''
    errorMessage.value = result.message
    ready.value = false
    const challenge = await bootstrapLoginCsrf(pageOrigin)
    ready.value = challenge.ok

    if (!challenge.ok) {
      errorMessage.value = challenge.message
    }

    submitting.value = false
    return
  }

  password.value = ''
  await navigateTo('/')
  submitting.value = false
}
</script>

<template>
  <main class="login-page">
    <h1 class="ui-page__title">Logowanie</h1>
    <p class="ui-page__note">Zaloguj się na swoje konto.</p>

    <p v-if="errorMessage" role="alert">
      {{ errorMessage }}
      <button
        v-if="!ready && !submitting"
        type="button"
        class="ui-touch"
        @click="prepareChallenge"
      >
        Spróbuj ponownie
      </button>
    </p>

    <form class="login-form ui-stack" @submit.prevent="submitForm">
      <label>
        E-mail
        <input
          v-model="email"
          type="email"
          name="email"
          autocomplete="username"
          required
          :disabled="submitting"
        />
      </label>
      <p v-if="fieldErrors.email">
        {{ fieldErrors.email }}
      </p>

      <label>
        Hasło
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          required
          :disabled="submitting"
        />
      </label>
      <p v-if="fieldErrors.password">
        {{ fieldErrors.password }}
      </p>

      <button class="ui-touch" type="submit" :disabled="submitting || !ready">
        {{ submitting ? 'Logowanie…' : 'Zaloguj' }}
      </button>
    </form>
  </main>
</template>

<style scoped>
.login-page {
  width: min(100%, 28rem);
}

.login-form label {
  display: grid;
  gap: 0.35rem;
}

.login-form input {
  min-height: 2.75rem;
  padding: 0 0.75rem;
  border: 1px solid var(--p-content-border-color, #d4d4d8);
  border-radius: 0.25rem;
}

.login-form button[type='submit'] {
  justify-self: start;
  padding: 0 1rem;
}
</style>
