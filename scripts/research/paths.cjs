const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../..', '.env') });

const repoRoot = path.resolve(__dirname, '../..');
const datasetDir = process.env.DATASET_DIR
  ? path.resolve(repoRoot, process.env.DATASET_DIR)
  : path.join(repoRoot, 'dataset');

module.exports = { repoRoot, datasetDir };
