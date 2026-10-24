export function hasConfiguredVariants(run) {
  return [
    run?.configuration?.normalized_variants,
    run?.requested_variants,
  ].some((variants) => Array.isArray(variants) && variants.length > 0);
}
