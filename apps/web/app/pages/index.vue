<script setup>
import { onMounted, ref } from 'vue'
import { notifyShopCartChanged } from '../components/shop/cart-count.js'
import { useCart } from '../composables/use-cart.js'
import { readList, useCatalog } from '../composables/use-catalog.js'
import { useGuestSession } from '../composables/use-guest-session.js'
import { formatAmount } from '../utils/money.js'

definePageMeta({ layout: 'shop' })

const catalog = useCatalog()
const cart = useCart()
const session = useGuestSession()
const products = ref([])
const categories = ref([])
const loading = ref(true)
const errorMessage = ref('')
const notice = ref('')
const addingId = ref('')

onMounted(async () => {
  session.ensure()
  const result = await catalog.load()
  loading.value = false

  if (result.products.error) {
    errorMessage.value = result.products.error.message
  } else {
    products.value = readList(result.products)
  }

  if (!result.categories.error) {
    categories.value = readList(result.categories)
  }
})

function categoryName(categoryId) {
  return (
    categories.value.find((category) => category.id === categoryId)?.name ?? ''
  )
}

function stockLabel(quantity) {
  return quantity === null || quantity === undefined
    ? 'Stan nieznany'
    : `Stan: ${quantity}`
}

async function addProduct(product) {
  notice.value = ''
  errorMessage.value = ''
  addingId.value = product.id
  const result = await cart.add(product.id, 1)
  addingId.value = ''

  if (result.error) {
    errorMessage.value = result.error.message
    return
  }

  notice.value = 'Dodano do koszyka.'
  notifyShopCartChanged()
}
</script>

<template>
  <main>
    <h1>Sklep</h1>
    <p v-if="loading">Ładowanie katalogu.</p>
    <p v-if="errorMessage">
      {{ errorMessage }}
    </p>
    <p v-if="notice">
      {{ notice }}
    </p>
    <p v-if="!loading && !errorMessage && products.length === 0">
      Brak produktów.
    </p>
    <ul v-if="products.length > 0">
      <li v-for="product in products" :key="product.id">
        <h2>{{ product.name }}</h2>
        <p v-if="product.description">
          {{ product.description }}
        </p>
        <p>{{ formatAmount(product.price_amount, product.currency) }}</p>
        <p v-if="categoryName(product.category_id)">
          {{ categoryName(product.category_id) }}
        </p>
        <p>{{ product.product_type }}</p>
        <p>{{ stockLabel(product.stock_quantity) }}</p>
        <button
          type="button"
          :disabled="addingId === product.id"
          @click="addProduct(product)"
        >
          Dodaj do koszyka
        </button>
      </li>
    </ul>
  </main>
</template>
