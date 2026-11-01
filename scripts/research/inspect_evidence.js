const fs = require('fs');
const path = require('path');

const { datasetDir } = require('./paths.cjs');
const evidenceDir = path.join(datasetDir, 'evidence');

// 1. Inspect SQL files
console.log('=== SQL FILES INSPECTION ===');
const dbDir = path.join(evidenceDir, 'databases');
if (fs.existsSync(dbDir)) {
  const sqlFiles = fs.readdirSync(dbDir).filter(f => f.endsWith('.sql'));
  console.log(`Found ${sqlFiles.length} SQL files:`);
  for (const f of sqlFiles) {
    const fullPath = path.join(dbDir, f);
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');
    const comments = lines.slice(0, 6).filter(l => l.startsWith('--')).map(l => l.trim()).join(' ');
    const tables = lines.filter(l => l.toUpperCase().includes('CREATE TABLE')).map(l => l.trim());
    console.log(`\nFile: ${f}`);
    console.log(`  Topology/Comment: ${comments}`);
    console.log(`  Tables created: ${tables.join(', ')}`);
  }
}
