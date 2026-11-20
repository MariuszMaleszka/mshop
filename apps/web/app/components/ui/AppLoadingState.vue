<script setup>
defineProps({
  message: {
    type: String,
    default: 'Ładowanie.',
  },
})
</script>

<template>
  <p role="status">
    {{ message }}
  </p>
</template>
