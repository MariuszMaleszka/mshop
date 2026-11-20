<script setup>
import { onMounted, ref } from 'vue'
import { readCart } from '../composables/use-cart.js'
import {
  checkoutErrorMessage,
  useCheckout,
} from '../composables/use-checkout.js'
import { withGuestSession } from '../composables/use-guest-session.js'

const checkout = useCheckout()
const api = useApi()
const form = ref({
  email: '',
  customerType: 'individual',
  firstName: '',
  lastName: '',
  companyName: '',
  nip: '',
  phone: '',
  recipient: '',
  street: '',
  buildingNumber: '',
  apartmentNumber: '',
  postalCode: '',
  city: '',
  countryCode: 'PL',
})
const fieldErrors = ref({})
const errorMessage = ref('')
const cartReady = ref(false)
const submitting = ref(false)

onMounted(async () => {
  const result = await withGuestSession(api.request, () => api.request('/cart'))
  const cart = readCart(result)
  cartReady.value = Boolean(cart && cart.items.length > 0)

  if (!cartReady.value && !result.error) {
    errorMessage.value = checkoutErrorMessage('CART_EMPTY', 409)
  }

  if (result.error) {
    errorMessage.value = checkoutErrorMessage(result.error.code, result.status)
  }
})

async function submitForm() {
  errorMessage.value = ''
  fieldErrors.value = {}
  submitting.value = true
  const result = await checkout.submit(form.value)
  submitting.value = false

  if (result.fields) {
    fieldErrors.value = result.fields
  }

  if (!result.ok) {
    errorMessage.value = checkoutErrorMessage(result.code, result.status)
    return
  }

  if (!/^[0-9a-f-]{36}$/i.test(result.orderId)) {
    errorMessage.value = checkoutErrorMessage('REQUEST_FAILED', 201)
    return
  }

  window.location.assign(`/orders/${result.orderId}`)
}

function beginNewAttempt() {
  checkout.beginNewAttempt()
  errorMessage.value = ''
  fieldErrors.value = {}
}
</script>

<template>
  <main>
    <h1>Zamówienie</h1>
    <p><a href="/cart">Koszyk</a></p>
    <p v-if="errorMessage">
      {{ errorMessage }}
    </p>
    <form v-if="cartReady" @submit.prevent="submitForm">
      <p>Płatność przy odbiorze.</p>
      <label>
        E-mail
        <input v-model="form.email" type="email" autocomplete="email" />
      </label>
      <p v-if="fieldErrors.email">
        {{ fieldErrors.email }}
      </p>
      <fieldset>
        <legend>Kupujący</legend>
        <label>
          <input v-model="form.customerType" type="radio" value="individual" />
          Osoba prywatna
        </label>
        <label>
          <input v-model="form.customerType" type="radio" value="company" />
          Firma
        </label>
      </fieldset>
      <template v-if="form.customerType === 'individual'">
        <label>
          Imię
          <input v-model="form.firstName" autocomplete="given-name" />
        </label>
        <p v-if="fieldErrors.firstName">
          {{ fieldErrors.firstName }}
        </p>
        <label>
          Nazwisko
          <input v-model="form.lastName" autocomplete="family-name" />
        </label>
        <p v-if="fieldErrors.lastName">
          {{ fieldErrors.lastName }}
        </p>
      </template>
      <template v-else>
        <label>
          Nazwa firmy
          <input v-model="form.companyName" autocomplete="organization" />
        </label>
        <p v-if="fieldErrors.companyName">
          {{ fieldErrors.companyName }}
        </p>
        <label>
          NIP
          <input v-model="form.nip" inputmode="numeric" />
        </label>
        <p v-if="fieldErrors.nip">
          {{ fieldErrors.nip }}
        </p>
      </template>
      <label>
        Telefon
        <input v-model="form.phone" type="tel" autocomplete="tel" />
      </label>
      <label>
        Ulica
        <input v-model="form.street" autocomplete="address-line1" />
      </label>
      <p v-if="fieldErrors.street">
        {{ fieldErrors.street }}
      </p>
      <label>
        Numer budynku
        <input v-model="form.buildingNumber" />
      </label>
      <p v-if="fieldErrors.buildingNumber">
        {{ fieldErrors.buildingNumber }}
      </p>
      <label>
        Numer mieszkania
        <input v-model="form.apartmentNumber" />
      </label>
      <label>
        Kod pocztowy
        <input v-model="form.postalCode" autocomplete="postal-code" />
      </label>
      <p v-if="fieldErrors.postalCode">
        {{ fieldErrors.postalCode }}
      </p>
      <label>
        Miasto
        <input v-model="form.city" autocomplete="address-level2" />
      </label>
      <p v-if="fieldErrors.city">
        {{ fieldErrors.city }}
      </p>
      <label>
        Kod kraju
        <input v-model="form.countryCode" maxlength="2" />
      </label>
      <p v-if="fieldErrors.countryCode">
        {{ fieldErrors.countryCode }}
      </p>
      <label>
        Odbiorca
        <input v-model="form.recipient" />
      </label>
      <button type="submit" :disabled="submitting">Złóż zamówienie</button>
      <button type="button" @click="beginNewAttempt">
        Rozpocznij nową próbę
      </button>
    </form>
  </main>
</template>
