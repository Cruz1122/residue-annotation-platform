export function runBelongsToProtein(run, proteinId) {
  return Boolean(
    proteinId
    && (run?.protein_id === proteinId || run?.external_tracking?.base_protein_id === proteinId),
  );
}
