<script setup>
import { onMounted, ref } from 'vue'
import {
  displayAmount,
  orderErrorMessage,
  readOrder,
  useOrder,
} from '../../composables/use-order.js'

definePageMeta({ layout: 'shop' })

const route = useRoute()
const orders = useOrder()
const order = ref(null)
const loading = ref(true)
const errorMessage = ref('')

onMounted(async () => {
  const orderId = String(route.params.id ?? '')

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      orderId,
    )
  ) {
    loading.value = false
    errorMessage.value = orderErrorMessage({
      error: { code: 'NOT_FOUND' },
      status: 404,
    })
    return
  }

  const result = await orders.load(orderId)
  loading.value = false

  if (result.error) {
    errorMessage.value = orderErrorMessage(result)
    return
  }

  order.value = readOrder(result)

  if (!order.value) {
    errorMessage.value = orderErrorMessage({
      error: { code: 'NOT_FOUND' },
      status: 404,
    })
  }
})

function amount(value, currency) {
  return displayAmount(value, currency) ?? value
}
</script>

<template>
  <main>
    <h1>Zamówienie</h1>
    <p v-if="loading">Ładowanie zamówienia.</p>
    <p v-if="errorMessage">
      {{ errorMessage }}
    </p>
    <section v-if="order">
      <p>Numer: {{ order.orderNumber }}</p>
      <p>Status płatności: {{ order.paymentStatus }}</p>
      <p>Status realizacji: {{ order.fulfillmentStatus }}</p>
      <p>Metoda płatności: {{ order.paymentMethod }}</p>
      <ul>
        <li v-for="(item, index) in order.items" :key="`${item.name}-${index}`">
          <h2>{{ item.name }}</h2>
          <p>Ilość: {{ item.quantity }}</p>
          <p>Cena: {{ amount(item.unitGrossAmount, item.currency) }}</p>
          <p>Pozycja: {{ amount(item.lineGrossAmount, item.currency) }}</p>
        </li>
      </ul>
      <p>Netto: {{ amount(order.netAmount, order.currency) }}</p>
      <p>VAT: {{ amount(order.taxAmount, order.currency) }}</p>
      <p>Brutto: {{ amount(order.grossAmount, order.currency) }}</p>
    </section>
  </main>
</template>
