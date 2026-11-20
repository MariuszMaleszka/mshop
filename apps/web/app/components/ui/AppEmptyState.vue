<script setup>
defineProps({
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    default: '',
  },
})
</script>

<template>
  <p role="status">
    <strong>{{ title }}</strong>
    <span v-if="message"> {{ message }}</span>
  </p>
</template>
