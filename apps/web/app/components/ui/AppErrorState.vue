<script setup>
defineProps({
  message: {
    type: String,
    required: true,
  },
})

defineEmits(['retry'])
</script>

<template>
  <p role="alert">
    {{ message }}
    <button type="button" class="ui-touch" @click="$emit('retry')">
      Spróbuj ponownie
    </button>
  </p>
</template>
