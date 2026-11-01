import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { datasetDirectory } from './config.js';

export const requiredDatasetFiles = [
  'deletion_requests.csv',
  'deletion_rules.csv',
  'evidence_files.csv',
  'output.csv',
  'sample_deletion_requests.csv',
  'sample_output.csv',
  'system_activity.csv',
  'user_audit_log.csv',
  'user_identities.csv'
];

export class DatasetNotFoundError extends Error {
  constructor(directory = datasetDirectory) {
    super(
      `Dataset not found at ${directory}. Download the participant files from HackerRank's Orchestrate challenge repository and place them in ./dataset, see README`
    );
    this.name = 'DatasetNotFoundError';
  }
}

export function datasetErrorMessage(directory = datasetDirectory) {
  return new DatasetNotFoundError(directory).message;
}

export function isDatasetAvailable(directory = datasetDirectory) {
  try {
    if (!statSync(directory).isDirectory()) return false;
    return requiredDatasetFiles.every((file) => {
      try {
        return statSync(join(directory, file)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function assertDatasetAvailable(directory = datasetDirectory) {
  if (!isDatasetAvailable(directory)) {
    throw new DatasetNotFoundError(directory);
  }
}
