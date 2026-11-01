import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const projectRoot = resolve(moduleDirectory, '..');

dotenv.config({ path: resolve(projectRoot, '.env') });

const configuredDatasetDirectory = process.env.DATASET_DIR?.trim();

export const datasetDirectory = configuredDatasetDirectory
  ? resolve(projectRoot, configuredDatasetDirectory)
  : resolve(projectRoot, 'dataset');
export const databasePath = resolve(projectRoot, 'data', 'orchestrate.sqlite');
export const samplePredictionPath = resolve(projectRoot, 'data', 'sample_predictions.csv');
export const outputPath = resolve(projectRoot, 'output.csv');
