<script setup>
defineProps({
  open: {
    type: Boolean,
    required: true,
  },
})

const route = useRoute()
const later = ['Produkty', 'Kategorie', 'Klienci', 'Ustawienia']

function ordersCurrent() {
  return route.path.startsWith('/admin/orders') ? 'page' : undefined
}
</script>

<template>
  <nav
    id="admin-nav"
    class="admin-nav"
    :class="{ 'is-open': open }"
    aria-label="Panel administracyjny"
  >
    <NuxtLink to="/admin/orders" :aria-current="ordersCurrent()">
      Zamówienia
    </NuxtLink>
    <button v-for="label in later" :key="label" type="button" disabled>
      <span>{{ label }}</span>
      <span>Wkrótce</span>
    </button>
  </nav>
</template>

<style scoped>
.admin-nav {
  display: none;
  gap: 0.25rem;
  padding: 0.75rem;
  background: var(--p-content-background, #fff);
}

.admin-nav.is-open {
  position: fixed;
  z-index: 3;
  top: 4.25rem;
  bottom: 0;
  left: 0;
  display: grid;
  align-content: start;
  width: min(18rem, calc(100% - 2rem));
  border-right: 1px solid var(--p-content-border-color, #d4d4d8);
}

.admin-nav a,
.admin-nav button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 2.75rem;
  padding: 0 0.75rem;
  color: inherit;
  font: inherit;
  text-align: left;
  text-decoration: none;
  background: transparent;
  border: 0;
  border-radius: 0.5rem;
}

.admin-nav a[aria-current='page'] {
  font-weight: 600;
  background: var(--p-content-hover-background, #f4f4f5);
}

.admin-nav button {
  color: #71717a;
  cursor: not-allowed;
}

.admin-nav a:focus-visible,
.admin-nav button:focus-visible {
  outline: 2px solid var(--p-primary-color, #0284c7);
  outline-offset: 2px;
}

@media (min-width: 48rem) {
  .admin-nav,
  .admin-nav.is-open {
    position: static;
    display: grid;
    width: 16rem;
    border-right: 1px solid var(--p-content-border-color, #d4d4d8);
  }
}
</style>
