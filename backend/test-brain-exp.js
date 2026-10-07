const h = require('./memory-brain-helper');
try {
  const out = h.getBrainExperiences(1);
  console.log('OK', out.items.length, 'items,', out.edges.length, 'edges');
  console.log('trunk:', JSON.stringify(out.trunk).slice(0,200));
} catch (e) {
  console.error('ERR:', e.message);
  console.error(e.stack);
}
