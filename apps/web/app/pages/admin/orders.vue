<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Button from 'primevue/button'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import InputText from 'primevue/inputtext'
import Paginator from 'primevue/paginator'
import Select from 'primevue/select'
import AppEmptyState from '../../components/ui/AppEmptyState.vue'
import AppErrorState from '../../components/ui/AppErrorState.vue'
import AppLoadingState from '../../components/ui/AppLoadingState.vue'
import AppStatusBadge from '../../components/ui/AppStatusBadge.vue'
import {
  ADMIN_FULFILLMENT_STATUSES,
  ADMIN_PAYMENT_METHODS,
  ADMIN_PAYMENT_STATUSES,
  adminOrdersFiltersActive,
  adminOrdersRequestPath,
  createAdminOrdersQuery,
  withAdminOrdersQuery,
} from '../../modules/admin-orders/query.js'
import {
  fulfillmentStatusView,
  paymentMethodLabel,
  paymentStatusView,
} from '../../modules/admin-orders/labels.js'
import { requestAdminOrders } from '../../modules/admin-orders/bff.js'
import { readAdminOrders } from '../../modules/admin-orders/view.js'

definePageMeta({ layout: 'admin' })

const pageOrigin = useRequestURL().origin
const query = ref(createAdminOrdersQuery())
const searchDraft = ref('')
const view = ref({ state: 'loading' })
const loading = ref(true)
let requestId = 0
let active = true

const paymentOptions = [
  { value: '', label: 'Każdy status płatności' },
  ...ADMIN_PAYMENT_STATUSES.map((value) => ({
    value,
    label: paymentStatusView(value).label,
  })),
]
const fulfillmentOptions = [
  { value: '', label: 'Każdy status realizacji' },
  ...ADMIN_FULFILLMENT_STATUSES.map((value) => ({
    value,
    label: fulfillmentStatusView(value).label,
  })),
]
const methodOptions = [
  { value: '', label: 'Każda metoda płatności' },
  ...ADMIN_PAYMENT_METHODS.map((value) => ({
    value,
    label: paymentMethodLabel(value),
  })),
]
const rows = computed(() =>
  view.value.state === 'ready' ? view.value.rows : [],
)
const total = computed(() => view.value.meta?.total ?? 0)
const first = computed(() => (query.value.page - 1) * query.value.limit)
const sortOrder = computed(() => (query.value.sortOrder === 'asc' ? 1 : -1))

function replaceQuery(patch, resetPage) {
  query.value = withAdminOrdersQuery(query.value, patch, { resetPage })
  load()
}

function applySearch() {
  replaceQuery({ search: searchDraft.value }, true)
}

function clearFilters() {
  searchDraft.value = ''
  query.value = createAdminOrdersQuery()
  load()
}

function onSort(event) {
  replaceQuery(
    {
      sortBy: event.sortField === 'orderNumber' ? 'orderNumber' : 'createdAt',
      sortOrder: event.sortOrder === 1 ? 'asc' : 'desc',
    },
    true,
  )
}

function onPage(event) {
  const limitChanged = event.rows !== query.value.limit
  replaceQuery(
    {
      page: limitChanged ? 1 : event.page + 1,
      limit: event.rows,
    },
    false,
  )
}

async function load() {
  const current = ++requestId
  loading.value = true
  const result = await requestAdminOrders(
    pageOrigin,
    adminOrdersRequestPath(query.value),
  )

  if (!active || current !== requestId) {
    return
  }

  view.value = readAdminOrders(result, adminOrdersFiltersActive(query.value))
  loading.value = false
}

onMounted(load)
onUnmounted(() => {
  active = false
})
</script>

<template>
  <section class="admin-orders">
    <h1>Zamówienia</h1>
    <form class="admin-orders__filters" @submit.prevent="applySearch">
      <label>
        Numer zamówienia
        <InputText v-model="searchDraft" @keydown.enter.prevent="applySearch" />
      </label>
      <label>
        Status płatności
        <Select
          :model-value="query.paymentStatus"
          :options="paymentOptions"
          option-label="label"
          option-value="value"
          @update:model-value="replaceQuery({ paymentStatus: $event }, true)"
        />
      </label>
      <label>
        Status realizacji
        <Select
          :model-value="query.fulfillmentStatus"
          :options="fulfillmentOptions"
          option-label="label"
          option-value="value"
          @update:model-value="
            replaceQuery({ fulfillmentStatus: $event }, true)
          "
        />
      </label>
      <label>
        Metoda płatności
        <Select
          :model-value="query.paymentMethod"
          :options="methodOptions"
          option-label="label"
          option-value="value"
          @update:model-value="replaceQuery({ paymentMethod: $event }, true)"
        />
      </label>
      <div class="admin-orders__actions">
        <Button type="submit" label="Szukaj" />
        <Button
          type="button"
          label="Wyczyść filtry"
          severity="secondary"
          @click="clearFilters"
        />
      </div>
    </form>

    <AppLoadingState v-if="loading" message="Ładowanie zamówień." />
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
    <AppErrorState
      v-else-if="view.state === 'error'"
      message="Nie udało się pobrać zamówień."
      @retry="load"
    />
    <AppEmptyState v-else-if="view.state === 'empty'" title="Brak zamówień." />
    <AppEmptyState
      v-else-if="view.state === 'filtered'"
      title="Brak zamówień dla wybranych filtrów."
    />
    <template v-else>
      <p>Liczba zamówień: {{ total }}</p>
      <div class="admin-orders__table">
        <DataTable
          :value="rows"
          lazy
          :sort-field="query.sortBy"
          :sort-order="sortOrder"
          @sort="onSort"
        >
          <Column field="orderNumber" header="Numer" sortable />
          <Column field="createdAt" header="Data" sortable />
          <Column field="email" header="Klient" />
          <Column field="amount" header="Kwota brutto" />
          <Column field="method" header="Metoda" />
          <Column header="Płatność">
            <template #body="{ data }">
              <AppStatusBadge
                :label="data.payment.label"
                :tone="data.payment.tone"
              />
            </template>
          </Column>
          <Column header="Realizacja">
            <template #body="{ data }">
              <AppStatusBadge
                :label="data.fulfillment.label"
                :tone="data.fulfillment.tone"
              />
            </template>
          </Column>
          <Column header="Szczegóły">
            <template #body="{ data }">
              <NuxtLink v-if="data.id" :to="`/admin/orders/${data.id}`">
                Szczegóły
              </NuxtLink>
            </template>
          </Column>
        </DataTable>
      </div>
      <div class="admin-orders__cards">
        <article v-for="row in rows" :key="row.id">
          <h2>{{ row.orderNumber }}</h2>
          <p>{{ row.createdAt }}</p>
          <p>{{ row.email }}</p>
          <p>{{ row.amount }}</p>
          <p>{{ row.method }}</p>
          <AppStatusBadge :label="row.payment.label" :tone="row.payment.tone" />
          <AppStatusBadge
            :label="row.fulfillment.label"
            :tone="row.fulfillment.tone"
          />
          <NuxtLink v-if="row.id" :to="`/admin/orders/${row.id}`"
            >Szczegóły</NuxtLink
          >
        </article>
      </div>
      <Paginator
        :first="first"
        :rows="query.limit"
        :total-records="total"
        :rows-per-page-options="[10, 20, 50, 100]"
        @page="onPage"
      />
    </template>
  </section>
</template>

<style scoped>
.admin-orders {
  display: grid;
  gap: 1rem;
  min-width: 0;
}

.admin-orders h1,
.admin-orders h2,
.admin-orders p {
  margin: 0;
}

.admin-orders__filters {
  display: grid;
  gap: 0.75rem;
}

.admin-orders__filters label {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}

.admin-orders__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.admin-orders__table {
  display: none;
  min-width: 0;
}

.admin-orders__cards {
  display: grid;
  gap: 0.75rem;
}

.admin-orders__cards article {
  display: grid;
  gap: 0.35rem;
  padding: 0.75rem;
  background: var(--p-content-background, #fff);
  border: 1px solid var(--p-content-border-color, #d4d4d8);
  border-radius: 0.5rem;
}

.admin-orders :deep(.p-datatable-table) {
  min-width: 0;
}

@media (min-width: 48rem) {
  .admin-orders__filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .admin-orders__table {
    display: block;
    overflow-x: auto;
  }

  .admin-orders__cards {
    display: none;
  }
}

@media (min-width: 80rem) {
  .admin-orders__filters {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
