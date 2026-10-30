export function runResultsRoute(run) {
  switch (run?.external_tracking?.run_type) {
    case 'ddg':
      return 'variant-ddg';
    case 'mutant':
    case 'base':
      return 'info';
    default:
      return 'topology';
  }
}
