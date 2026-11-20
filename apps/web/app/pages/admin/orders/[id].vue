<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import AppEmptyState from '../../../components/ui/AppEmptyState.vue'
import AppErrorState from '../../../components/ui/AppErrorState.vue'
import AppLoadingState from '../../../components/ui/AppLoadingState.vue'
import AppStatusBadge from '../../../components/ui/AppStatusBadge.vue'
import { readAdminOrder } from '../../../modules/admin-orders/view.js'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const api = useApi()
const view = ref({ state: 'loading' })
const loading = ref(true)
let active = true

const orderId = computedOrderId(route.params.id)

function computedOrderId(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : ''
}

async function load() {
  loading.value = true

  if (!orderId) {
    view.value = { state: 'missing' }
    loading.value = false
    return
  }

  const result = await api.request(`admin/orders/${orderId}`)

  if (!active) {
    return
  }

  view.value = readAdminOrder(result)
  loading.value = false
}

onMounted(load)
onUnmounted(() => {
  active = false
})
</script>

<template>
  <section class="admin-order">
    <p><NuxtLink to="/admin/orders">Wróć do listy</NuxtLink></p>
    <AppLoadingState v-if="loading" message="Ładowanie zamówienia." />
    <AppErrorState
      v-else-if="view.state === 'unauthorized'"
      message="Panel wymaga zalogowania administratora. Logowanie nie jest jeszcze podłączone."
      @retry="load"
    />
    <AppErrorState
      v-else-if="view.state === 'forbidden'"
      message="To konto nie ma uprawnień administratora."
      @retry="load"
    />
    <AppEmptyState
      v-else-if="view.state === 'missing'"
      title="Nie znaleziono zamówienia."
    />
    <AppErrorState
      v-else-if="view.state === 'error'"
      message="Nie udało się pobrać zamówienia."
      @retry="load"
    />
    <template v-else>
      <h1>{{ view.order.orderNumber }}</h1>
      <p>{{ view.order.createdAt }}</p>
      <p>{{ view.order.email }}</p>
      <p>{{ view.order.amount }}</p>
      <p>{{ view.order.method }}</p>
      <AppStatusBadge
        :label="view.order.payment.label"
        :tone="view.order.payment.tone"
      />
      <AppStatusBadge
        :label="view.order.fulfillment.label"
        :tone="view.order.fulfillment.tone"
      />
      <h2>Płatności</h2>
      <p v-if="view.order.payments.length === 0">Brak płatności.</p>
      <article v-for="payment in view.order.payments" :key="payment.id">
        <AppStatusBadge
          :label="payment.status.label"
          :tone="payment.status.tone"
        />
        <p v-if="payment.initialization">
          Stan rejestracji: {{ payment.initialization }}
        </p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.admin-order {
  display: grid;
  justify-items: start;
  gap: 0.75rem;
  min-width: 0;
}

.admin-order h1,
.admin-order h2,
.admin-order p {
  margin: 0;
}
</style>
