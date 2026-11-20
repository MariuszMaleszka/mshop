<script setup>
import Tag from 'primevue/tag'

const props = defineProps({
  label: {
    type: String,
    required: true,
  },
  tone: {
    type: String,
    default: 'neutral',
  },
})

const severity = {
  neutral: 'secondary',
  info: 'info',
  success: 'success',
  warning: 'warn',
  danger: 'danger',
}
</script>

<template>
  <Tag :value="props.label" :severity="severity[props.tone] ?? 'secondary'" />
</template>
