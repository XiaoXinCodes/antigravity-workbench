// Reuses the isolated profile, synthetic transport and privacy checks of the production UI runner.
process.env.AG_UNIFIED_DESIGN_HOST='1';
require('./test-ui-screenshots.cjs');
