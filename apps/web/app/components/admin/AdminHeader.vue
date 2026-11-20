<script setup>
defineProps({
  open: {
    type: Boolean,
    required: true,
  },
})

defineEmits(['toggle'])
</script>

<template>
  <header class="admin-header">
    <div>
      <p class="admin-header__mark">mshop</p>
      <p class="admin-header__title">Panel administracyjny</p>
    </div>
    <button
      class="ui-touch"
      type="button"
      :aria-expanded="open"
      aria-controls="admin-nav"
      @click="$emit('toggle')"
    >
      {{ open ? 'Zamknij menu' : 'Menu' }}
    </button>
  </header>
</template>

<style scoped>
.admin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  min-height: 4.25rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--p-content-border-color, #d4d4d8);
  background: var(--p-content-background, #fff);
}

.admin-header p {
  margin: 0;
}

.admin-header__mark {
  font-weight: 700;
}

.admin-header__title {
  color: #3f3f46;
  font-size: 0.875rem;
}

.admin-header button {
  padding: 0 0.75rem;
}

.admin-header button:focus-visible {
  outline: 2px solid var(--p-primary-color, #0284c7);
  outline-offset: 2px;
}

@media (min-width: 48rem) {
  .admin-header button {
    display: none;
  }
}
</style>
