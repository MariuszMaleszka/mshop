<script setup>
import { onMounted, ref } from 'vue'
import { readCart, useCart } from '../composables/use-cart.js'
import { formatAmount } from '../utils/money.js'

const cartApi = useCart()
const cart = ref(null)
const quantities = ref({})
const loading = ref(true)
const errorMessage = ref('')
const pendingId = ref('')

onMounted(load)

async function load() {
  loading.value = true
  errorMessage.value = ''
  const result = await cartApi.load()
  loading.value = false

  if (result.error) {
    cart.value = null
    errorMessage.value = result.error.message
    return
  }

  const next = readCart(result)
  cart.value = next
  quantities.value = Object.fromEntries(
    (next?.items ?? []).map((item) => [item.id, String(item.quantity)]),
  )
}

async function saveQuantity(item) {
  errorMessage.value = ''
  const quantity = Number(quantities.value[item.id])

  if (
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    quantity > 2147483647
  ) {
    errorMessage.value = 'Podaj dodatnią ilość.'
    return
  }

  pendingId.value = item.id
  const result = await cartApi.update(item.id, quantity)
  pendingId.value = ''

  if (result.error) {
    errorMessage.value = result.error.message
    return
  }

  await applyCart(result)
}

async function removeItem(item) {
  errorMessage.value = ''
  pendingId.value = item.id
  const result = await cartApi.remove(item.id)
  pendingId.value = ''

  if (result.error) {
    errorMessage.value = result.error.message
    return
  }

  await applyCart(result)
}

function applyCart(result) {
  const next = readCart(result)
  cart.value = next
  quantities.value = Object.fromEntries(
    (next?.items ?? []).map((item) => [item.id, String(item.quantity)]),
  )
}
</script>

<template>
  <main>
    <h1>Koszyk</h1>
    <p>
      <a href="/">Sklep</a>
      <a v-if="cart && cart.items.length > 0" href="/checkout"
        >Złóż zamówienie</a
      >
    </p>
    <p v-if="loading">Ładowanie koszyka.</p>
    <p v-if="errorMessage">
      {{ errorMessage }}
    </p>
    <p v-if="!loading && cart && cart.items.length === 0">Koszyk jest pusty.</p>
    <ul v-if="cart && cart.items.length > 0">
      <li v-for="item in cart.items" :key="item.id">
        <h2>{{ item.name }}</h2>
        <p>{{ formatAmount(item.price_amount, item.currency) }}</p>
        <p>{{ formatAmount(item.line_amount, item.currency) }}</p>
        <label>
          Ilość
          <input v-model="quantities[item.id]" inputmode="numeric" />
        </label>
        <button
          type="button"
          :disabled="pendingId === item.id"
          @click="saveQuantity(item)"
        >
          Zapisz ilość
        </button>
        <button
          type="button"
          :disabled="pendingId === item.id"
          @click="removeItem(item)"
        >
          Usuń
        </button>
      </li>
    </ul>
    <p v-if="cart">
      Suma: {{ formatAmount(cart.total_amount, cart.currency) }}
    </p>
  </main>
</template>
