<script setup>
import ShopFooter from '../components/shop/ShopFooter.vue'
import ShopHeader from '../components/shop/ShopHeader.vue'
</script>

<template>
  <div class="shop-shell">
    <ShopHeader />
    <div class="shop-shell__content">
      <slot />
    </div>
    <ShopFooter />
  </div>
</template>

<style scoped>
.shop-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  overflow-x: clip;
}

.shop-shell__content {
  width: min(100%, 72rem);
  margin: 0 auto;
  padding: 1rem;
  flex: 1;
}

@media (min-width: 48rem) {
  .shop-shell__content {
    padding: 1.5rem;
  }
}
</style>
