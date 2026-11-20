<script setup>
import { onUnmounted, ref, watch } from 'vue'
import AdminHeader from '../components/admin/AdminHeader.vue'
import AdminSidebar from '../components/admin/AdminSidebar.vue'

const route = useRoute()

useHead({ title: 'Panel administracyjny' })
const open = ref(false)

function toggle() {
  open.value = !open.value
}

function close() {
  open.value = false
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    close()
  }
}

watch(
  () => route.fullPath,
  () => {
    close()
  },
)

watch(open, (value) => {
  if (value) {
    window.addEventListener('keydown', onKeydown)
    return
  }

  window.removeEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="admin-shell">
    <AdminHeader :open="open" @toggle="toggle" />
    <div class="admin-shell__body">
      <button
        v-if="open"
        class="admin-shell__backdrop"
        type="button"
        aria-label="Zamknij menu"
        @click="close"
      />
      <AdminSidebar :open="open" />
      <main class="admin-shell__content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.admin-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  overflow-x: clip;
  background: var(--p-surface-50, #fafafa);
}

.admin-shell__body {
  display: flex;
  flex: 1;
  min-width: 0;
}

.admin-shell__content {
  flex: 1;
  min-width: 0;
  padding: 1rem;
}

.admin-shell__backdrop {
  position: fixed;
  z-index: 2;
  inset: 4.25rem 0 0;
  padding: 0;
  background: rgb(0 0 0 / 35%);
  border: 0;
}

@media (min-width: 48rem) {
  .admin-shell__content {
    padding: 1.5rem;
  }

  .admin-shell__backdrop {
    display: none;
  }
}
</style>
