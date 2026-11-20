<template>
  <footer class="shop-footer">
    <p>Dane sprzedawcy nie są jeszcze opublikowane.</p>
    <p>Kontakt nie jest jeszcze opublikowany.</p>
    <ul>
      <li>Regulamin</li>
      <li>Polityka prywatności</li>
      <li>Dostawa</li>
      <li>Płatności</li>
    </ul>
  </footer>
</template>

<style scoped>
.shop-footer {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border-top: 1px solid var(--p-content-border-color, #d4d4d8);
}

.shop-footer p,
.shop-footer ul {
  margin: 0;
}

.shop-footer ul {
  display: grid;
  gap: 0.5rem;
  padding: 0;
  list-style: none;
}

@media (min-width: 48rem) {
  .shop-footer {
    grid-template-columns: 1fr 1fr;
    padding: 1.5rem;
  }

  .shop-footer ul {
    grid-column: 1 / -1;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
</style>
