import { definePreset } from '@primeuix/themes'
import Aura from '@primeuix/themes/aura'

const ShopPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{sky.50}',
      100: '{sky.100}',
      200: '{sky.200}',
      300: '{sky.300}',
      400: '{sky.400}',
      500: '{sky.500}',
      600: '{sky.600}',
      700: '{sky.700}',
      800: '{sky.800}',
      900: '{sky.900}',
      950: '{sky.950}',
    },
    font: {
      family: 'Poppins, sans-serif',
    },
    borderRadius: {
      xs: '0.25rem',
      sm: '0.375rem',
      md: '0.5rem',
      lg: '0.75rem',
      xl: '1rem',
    },
  },
})

export default {
  preset: ShopPreset,
  options: {
    prefix: 'p',
    darkModeSelector: '.shop-dark',
    cssLayer: false,
  },
}
