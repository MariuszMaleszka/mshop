<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { readCart, useCart } from '../../composables/use-cart.js'
import { cartItemCount, onShopCartChange } from './cart-count.js'

const route = useRoute()
const cart = useCart()
const open = ref(false)
const count = ref(null)

const links = [
  { to: '/', label: 'Sklep' },
  { to: '/cart', label: 'Koszyk' },
]

let active = true

async function refreshCount() {
  const result = await cart.load()

  if (!active) {
    return
  }

  count.value = cartItemCount(readCart(result))
}

function closeMenu() {
  open.value = false
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    closeMenu()
  }
}

watch(open, (value) => {
  if (value) {
    window.addEventListener('keydown', onKeydown)
    return
  }

  window.removeEventListener('keydown', onKeydown)
})

watch(
  () => route.fullPath,
  () => {
    closeMenu()
    refreshCount()
  },
)

onMounted(() => {
  refreshCount()
})

onUnmounted(() => {
  active = false
  window.removeEventListener('keydown', onKeydown)
})

const stopCartWatch = onShopCartChange(refreshCount)

onUnmounted(stopCartWatch)
</script>

<template>
  <header class="shop-header">
    <NuxtLink class="shop-header__name" to="/">Sklep</NuxtLink>
    <div class="shop-header__account" />
    <button
      class="shop-header__menu ui-touch"
      type="button"
      :aria-expanded="open"
      aria-controls="shop-nav"
      @click="open = !open"
    >
      {{ open ? 'Zamknij' : 'Menu' }}
    </button>
    <nav id="shop-nav" class="shop-nav" :class="{ 'is-open': open }">
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :aria-current="route.path === link.to ? 'page' : undefined"
        @click="closeMenu"
      >
        {{ link.label }}
        <span v-if="link.to === '/cart' && count !== null">{{ count }}</span>
      </NuxtLink>
    </nav>
  </header>
</template>

<style scoped>
.shop-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color, #d4d4d8);
}

.shop-header__name,
.shop-nav a {
  color: inherit;
  text-decoration: none;
}

.shop-header__name {
  display: inline-flex;
  align-items: center;
  min-height: 2.75rem;
  font-weight: 600;
}

.shop-header__account {
  flex: 1;
}

.shop-header__menu {
  min-width: 2.75rem;
  padding: 0 0.75rem;
}

.shop-nav {
  display: none;
}

.shop-nav.is-open {
  position: absolute;
  top: 100%;
  right: 0;
  left: 0;
  z-index: 2;
  display: grid;
  padding: 0.5rem;
  background: var(--p-content-background, #fff);
  border-bottom: 1px solid var(--p-content-border-color, #d4d4d8);
}

.shop-nav a {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: space-between;
  min-height: 2.75rem;
  padding: 0 0.75rem;
}

.shop-header a:focus-visible,
.shop-header button:focus-visible {
  outline: 2px solid var(--p-primary-color, #0284c7);
  outline-offset: 2px;
}

@media (min-width: 48rem) {
  .shop-header__menu {
    display: none;
  }

  .shop-nav {
    display: flex;
    gap: 0.25rem;
  }

  .shop-nav a {
    min-width: 2.75rem;
  }
}
</style>
