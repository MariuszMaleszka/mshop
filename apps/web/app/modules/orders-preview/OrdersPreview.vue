<script setup>
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Column from 'primevue/column'
import DataTable from 'primevue/datatable'
import DatePicker from 'primevue/datepicker'
import InputText from 'primevue/inputtext'
import Menu from 'primevue/menu'
import Paginator from 'primevue/paginator'
import Select from 'primevue/select'
import AppEmptyState from '../../components/ui/AppEmptyState.vue'
import AppErrorState from '../../components/ui/AppErrorState.vue'
import AppLoadingState from '../../components/ui/AppLoadingState.vue'
import AppStatusBadge from '../../components/ui/AppStatusBadge.vue'
import { loadOrdersPreview } from './load-orders.js'
import { PREVIEW_ORDERS } from './records.js'
import { formatAmount } from '../../utils/money.js'

const fulfillmentOptions = [
  { value: null, label: 'Każdy status realizacji' },
  { value: 'new', label: 'Nowe' },
  { value: 'processing', label: 'W realizacji' },
  { value: 'completed', label: 'Zrealizowane' },
  { value: 'cancelled', label: 'Anulowane' },
]
const paymentOptions = [
  { value: null, label: 'Każdy status płatności' },
  { value: 'pending', label: 'Oczekuje' },
  { value: 'paid', label: 'Opłacone' },
  { value: 'failed', label: 'Nieudane' },
  { value: 'cancelled', label: 'Anulowana' },
  { value: 'refunded', label: 'Zwrot' },
  { value: 'partially_refunded', label: 'Częściowy zwrot' },
]
const tones = {
  new: 'info',
  processing: 'warning',
  completed: 'success',
  cancelled: 'neutral',
  pending: 'warning',
  paid: 'success',
  failed: 'danger',
  refunded: 'info',
  partially_refunded: 'info',
}

const query = ref({
  page: 1,
  limit: 10,
  sortField: 'createdAt',
  sortOrder: 'desc',
  search: '',
  fulfillmentStatus: null,
  paymentStatus: null,
  dateFrom: null,
  dateTo: null,
})
const searchDraft = ref('')
const dateRange = ref(null)
const filtersOpen = ref(false)
const records = ref([])
const total = ref(0)
const selected = ref([])
const loading = ref(true)
const failed = ref(false)
const forceError = ref(false)
const notice = ref('')
const activeRow = ref(null)
const rowMenu = ref(null)

const first = computed(() => (query.value.page - 1) * query.value.limit)
const sortOrder = computed(() => (query.value.sortOrder === 'asc' ? 1 : -1))
const rowActions = computed(() => [
  {
    label: activeRow.value
      ? `Podgląd ${activeRow.value.orderNumber}`
      : 'Podgląd',
    command() {
      notice.value = activeRow.value
        ? `Akcja podglądu dla ${activeRow.value.orderNumber}.`
        : ''
    },
  },
])

onMounted(() => {
  refresh()
})

async function refresh() {
  loading.value = true
  notice.value = ''
  const result = await loadOrdersPreview({
    records: PREVIEW_ORDERS,
    query: query.value,
    fail: forceError.value,
  })
  loading.value = false
  failed.value = !result.ok
  records.value = result.records
  total.value = result.total
  selected.value = []
}

function applySearch() {
  query.value.search = searchDraft.value
  query.value.page = 1
  applyDates()
  refresh()
}

function applyDates() {
  const range = dateRange.value ?? []
  query.value.dateFrom = range[0] ?? null
  query.value.dateTo = range[1] ?? null
}

function changeFilter() {
  query.value.page = 1
  applyDates()
  refresh()
}

function onPage(event) {
  query.value.page = event.page + 1
  query.value.limit = event.rows
  refresh()
}

function onSort(event) {
  query.value.sortField = event.sortField
  query.value.sortOrder = event.sortOrder === 1 ? 'asc' : 'desc'
  query.value.page = 1
  refresh()
}

function openRowMenu(event, row) {
  activeRow.value = row
  rowMenu.value.toggle(event)
}

function runBulkAction() {
  notice.value = `Zaznaczono ${selected.value.length} rekordów w podglądzie.`
}

function showError() {
  forceError.value = true
  refresh()
}

function clearError() {
  forceError.value = false
  refresh()
}

function money(amount) {
  return formatAmount(amount, 'PLN')
}

function tone(value) {
  return tones[value] ?? 'neutral'
}

function fulfillmentText(value) {
  return fulfillmentOptions.find((item) => item.value === value)?.label ?? value
}

function paymentText(value) {
  return paymentOptions.find((item) => item.value === value)?.label ?? value
}

function toggleRow(row, checked) {
  if (checked) {
    selected.value = [...selected.value, row]
    return
  }

  selected.value = selected.value.filter((item) => item.id !== row.id)
}

function rowSelected(row) {
  return selected.value.some((item) => item.id === row.id)
}
</script>

<template>
  <main class="ui-page">
    <h1 class="ui-page__title">Podgląd zamówień</h1>
    <p class="ui-page__note">Dane przykładowe. Tabela nie czyta API sklepu.</p>
    <form
      class="ui-stack orders-filters"
      :class="{ 'is-open': filtersOpen }"
      @submit.prevent="applySearch"
    >
      <label>
        Szukaj
        <InputText v-model="searchDraft" class="ui-touch" />
      </label>
      <label>
        Realizacja
        <Select
          v-model="query.fulfillmentStatus"
          :options="fulfillmentOptions"
          option-label="label"
          option-value="value"
          @change="changeFilter"
        />
      </label>
      <label>
        Płatność
        <Select
          v-model="query.paymentStatus"
          :options="paymentOptions"
          option-label="label"
          option-value="value"
          @change="changeFilter"
        />
      </label>
      <label>
        Daty
        <DatePicker
          v-model="dateRange"
          selection-mode="range"
          date-format="yy-mm-dd"
          @value-change="changeFilter"
        />
      </label>
      <Button type="submit" label="Szukaj" class="ui-touch" />
    </form>
    <p class="orders-filter-toggle">
      <Button
        type="button"
        label="Filtry"
        @click="filtersOpen = !filtersOpen"
      />
    </p>
    <p>
      <Button
        type="button"
        label="Akcja grupowa"
        :disabled="selected.length === 0"
        @click="runBulkAction"
      />
      <Button
        type="button"
        label="Pokaż błąd"
        severity="secondary"
        @click="showError"
      />
    </p>
    <p v-if="notice">
      {{ notice }}
    </p>
    <AppLoadingState v-if="loading" />
    <AppErrorState
      v-else-if="failed"
      message="Nie udało się odczytać podglądu."
      @retry="clearError"
    />
    <AppEmptyState
      v-else-if="records.length === 0"
      title="Brak zamówień."
      message="Zmień filtry podglądu."
    />
    <template v-else>
      <div class="orders-cards">
        <article v-for="row in records" :key="row.id">
          <label>
            <Checkbox
              :model-value="rowSelected(row)"
              binary
              @update:model-value="toggleRow(row, $event)"
            />
            {{ row.orderNumber }}
          </label>
          <p>{{ row.createdAt }}</p>
          <p>{{ row.customerName }}</p>
          <p>{{ money(row.grossAmount) }}</p>
          <p>
            <AppStatusBadge
              :label="fulfillmentText(row.fulfillmentStatus)"
              :tone="tone(row.fulfillmentStatus)"
            />
            <AppStatusBadge
              :label="paymentText(row.paymentStatus)"
              :tone="tone(row.paymentStatus)"
            />
          </p>
          <details>
            <summary>Szczegóły</summary>
            <p>{{ row.deliveryMethod }}</p>
          </details>
          <Button
            type="button"
            label="Akcje"
            @click="openRowMenu($event, row)"
          />
        </article>
      </div>
      <DataTable
        v-model:selection="selected"
        class="orders-table"
        :value="records"
        data-key="id"
        lazy
        paginator
        :rows="query.limit"
        :first="first"
        :total-records="total"
        :sort-field="query.sortField"
        :sort-order="sortOrder"
        @page="onPage"
        @sort="onSort"
      >
        <Column selection-mode="multiple" />
        <Column field="orderNumber" header="Numer" sortable />
        <Column field="createdAt" header="Data" sortable />
        <Column field="customerName" header="Klient" sortable />
        <Column field="grossAmount" header="Wartość" sortable>
          <template #body="{ data }">
            {{ money(data.grossAmount) }}
          </template>
        </Column>
        <Column field="fulfillmentStatus" header="Realizacja" sortable>
          <template #body="{ data }">
            <AppStatusBadge
              :label="fulfillmentText(data.fulfillmentStatus)"
              :tone="tone(data.fulfillmentStatus)"
            />
          </template>
        </Column>
        <Column field="paymentStatus" header="Płatność" sortable>
          <template #body="{ data }">
            <AppStatusBadge
              :label="paymentText(data.paymentStatus)"
              :tone="tone(data.paymentStatus)"
            />
          </template>
        </Column>
        <Column field="deliveryMethod" header="Dostawa" sortable />
        <Column header="Akcje">
          <template #body="{ data }">
            <Button
              type="button"
              label="Akcje"
              @click="openRowMenu($event, data)"
            />
          </template>
        </Column>
      </DataTable>
      <Paginator
        class="orders-cards"
        :rows="query.limit"
        :first="first"
        :total-records="total"
        @page="onPage"
      />
    </template>
    <Menu ref="rowMenu" :model="rowActions" popup />
  </main>
</template>

<style scoped>
.orders-filters {
  display: none;
}

.orders-filters.is-open {
  display: grid;
}

.orders-cards {
  display: grid;
  gap: 0.75rem;
}

.orders-table {
  display: none;
}

.orders-cards article {
  display: grid;
  gap: 0.35rem;
  padding: 0.75rem 0;
  border-top: 1px solid var(--p-content-border-color, #d4d4d8);
}

@media (min-width: 48rem) {
  .orders-filters {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .orders-filter-toggle {
    display: none;
  }

  .orders-cards {
    display: none;
  }

  .orders-table {
    display: block;
  }
}
</style>
