export function loadCatalog(request) {
  return Promise.all([
    request('/categories?page=1&limit=20'),
    request('/products?page=1&limit=20'),
  ]).then(([categories, products]) => ({ categories, products }))
}

export function readList(result) {
  const rows = result?.data?.data

  return Array.isArray(rows) ? rows : []
}

export function useCatalog() {
  const api = useApi()

  return {
    load() {
      return loadCatalog(api.request)
    },
  }
}
