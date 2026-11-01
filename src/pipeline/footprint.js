import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, resolve } from 'node:path';
import { z } from 'zod';
import { resolveIdentity } from './identity.js';
import { filterActivityAtOrBefore, filterEvidenceAtOrBefore, isAtOrBefore } from './time.js';
import { datasetDirectory } from '../config.js';

const requestSchema = z.object({
  case_id: z.string().optional(),
  email: z.string().trim().min(1),
  audit_at: z.string().min(1)
});

const evidenceIndexCache = new WeakMap();
const evidenceFactCache = new WeakMap();

const categoryBySystem = {
  account_service: 'USER_PROFILE',
  analytics_platform: 'ANALYTICS_PROFILE',
  backup_service: 'BACKUP_ARCHIVE',
  cache_service: 'CACHE_ENTRY',
  export_service: 'USER_EXPORT',
  identity_service: 'ACCOUNT_TOMBSTONE',
  integration_service: 'DATA_FLOW',
  legal_service: 'LEGAL_HOLD_RECORD',
  marketing_platform: 'MARKETING_PROFILE',
  search_service: 'SEARCH_INDEX_ENTRY',
  security_service: 'SECURITY_AUDIT_LOG',
  support_platform: 'SUPPORT_MESSAGE'
};

const categoryByResourcePrefix = {
  account: ['USER_PROFILE'],
  analytics: ['ANALYTICS_PROFILE', 'PRODUCT_TELEMETRY'],
  audit: ['SECURITY_AUDIT_LOG'],
  backup: ['BACKUP_ARCHIVE'],
  cache: ['CACHE_ENTRY'],
  data: ['DATA_FLOW'],
  export: ['USER_EXPORT'],
  legal: ['LEGAL_HOLD_RECORD'],
  marketing: ['MARKETING_PROFILE'],
  search: ['SEARCH_INDEX_ENTRY'],
  support: ['SUPPORT_MESSAGE', 'SUPPORT_ATTACHMENT'],
  tombstone: ['ACCOUNT_TOMBSTONE']
};

const identifierFieldTypes = new Map([
  ['email', 'email'],
  ['emailaddress', 'email'],
  ['customeremail', 'email'],
  ['requesteremail', 'email'],
  ['owneremail', 'email'],
  ['phone', 'phone'],
  ['phonenumber', 'phone'],
  ['telephone', 'phone'],
  ['mobile', 'phone'],
  ['emailhash', 'email_hash'],
  ['emailsha256', 'email_hash'],
  ['hashedemail', 'email_hash'],
  ['userid', 'user_id'],
  ['customerreference', 'user_id'],
  ['customerref', 'user_id'],
  ['subjectreference', 'user_id'],
  ['subjectref', 'user_id']
]);

const identifierLookupFields = new Set([
  'lookupkey',
  'subjectkey',
  'matchkey',
  'correlationkey',
  'matchedvalue',
  'lookupvalue'
]);

const traceFields = new Set([
  'traceid',
  'requestid',
  'correlationid',
  'transactionid',
  'operationid',
  'spanid'
]);

function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function normalizedIdentifier(value, type) {
  const text = String(value).trim();
  return type === 'email' || type === 'email_hash' ? text.toLowerCase() : text;
}

function identifiersFor(identity) {
  return [
    ...identity.identifiers.emails.map((value) => ({ type: 'email', value })),
    ...identity.identifiers.phones.map((value) => ({ type: 'phone', value })),
    ...identity.identifiers.emailHashes.map((value) => ({ type: 'email_hash', value })),
    ...(identity.userId ? [{ type: 'user_id', value: identity.userId }] : [])
  ].map(({ type, value }) => ({
    type,
    value: normalizedIdentifier(value, type)
  }));
}

function identifierKey(type, value) {
  return `${type}\u0000${normalizedIdentifier(value, type)}`;
}

function readEvidenceFacts(database) {
  const cached = evidenceFactCache.get(database);
  if (cached) return cached;

  const facts = database.prepare(
    `SELECT evidence_id, system_id, resource_id, data_category, identifiers, captured_at
     FROM evidence_facts
     WHERE resource_id IS NOT NULL`
  ).all().map((fact) => {
    try {
      return { ...fact, identifierValues: JSON.parse(fact.identifiers ?? '{}') };
    } catch (error) {
      throw new Error(`Invalid identifiers JSON in ${fact.evidence_id}`, { cause: error });
    }
  });
  const identifierFields = [
    ['email', 'email'],
    ['phone', 'phone'],
    ['email_hash', 'email_hash'],
    ['user_id', 'user_id'],
    ['customer_reference', 'user_id'],
    ['subject_reference', 'user_id']
  ];
  const byIdentifier = new Map();
  for (const fact of facts) {
    for (const [field, type] of identifierFields) {
      const value = fact.identifierValues[field];
      if (value === null || value === undefined) continue;
      const key = identifierKey(type, value);
      const matchingFacts = byIdentifier.get(key) ?? [];
      matchingFacts.push(fact);
      byIdentifier.set(key, matchingFacts);
    }
  }
  const index = {
    facts,
    byIdentifier,
    singletonFacts: facts.filter((fact) => (
      fact.system_id === 'account_service' || fact.system_id === 'security_service'
    ))
  };
  evidenceFactCache.set(database, index);
  return index;
}

function collectStrings(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, result);
  } else if (typeof value === 'string') {
    result.push(value);
    const text = value.trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        collectStrings(JSON.parse(text), result);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return result;
}

function inferLookupIdentifier(value) {
  const text = String(value).trim();
  if (text.includes('@')) return { type: 'email', value: text };
  if (/^[a-f\d]{64}$/iu.test(text)) return { type: 'email_hash', value: text };
  if (/^user_[\p{L}\p{N}_-]+$/iu.test(text)) return { type: 'user_id', value: text };
  if (/^\+?[\d().\s-]{7,}$/u.test(text)) return { type: 'phone', value: text };
  return null;
}

function identifiersFromRecord(record) {
  const identifiers = [];
  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        const normalizedKey = normalizeKey(key);
        const type = identifierFieldTypes.get(normalizedKey);
        if (type) identifiers.push({ type, value: child });
        else if (identifierLookupFields.has(normalizedKey)) {
          const inferred = inferLookupIdentifier(child);
          if (inferred) identifiers.push(inferred);
        }
        const trimmed = child.trim();
        if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
          try {
            visit(JSON.parse(trimmed));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  }
  visit(record);
  return identifiers;
}

function allIdentifiersFromRecord(record) {
  const identifiers = identifiersFromRecord(record);
  const strings = collectStrings(record);
  const patterns = [
    ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu],
    ['email_hash', /(?<![A-F\d])[A-F\d]{64}(?![A-F\d])/giu],
    ['user_id', /(?<![\p{L}\p{N}_])user_[\p{L}\p{N}_-]+(?![\p{L}\p{N}_])/giu],
    ['phone', /(?<![\p{L}\p{N}])\+?\d[\d().\s-]{5,}\d(?![\p{L}\p{N}])/gu]
  ];
  for (const text of strings) {
    for (const [type, pattern] of patterns) {
      for (const match of text.matchAll(pattern)) {
        identifiers.push({ type, value: match[0].trim() });
      }
    }
  }
  return [...new Map(identifiers.map(({ type, value }) => {
    const normalized = normalizedIdentifier(value, type);
    return [`${type}\u0000${normalized}`, { type, value: normalized }];
  })).values()];
}

function directResourceReferences(record) {
  const references = [];
  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && normalizeKey(key).endsWith('resourceid')) {
        references.push({ field: key, value: child.trim() });
      } else if (child && typeof child === 'object') {
        visit(child);
      } else if (typeof child === 'string') {
        const trimmed = child.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try {
            visit(JSON.parse(trimmed));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
        }
      }
    }
  }
  visit(record);
  return [...new Map(references.filter(({ value }) => value).map((item) => [
    `${item.field}\u0000${item.value}`,
    item
  ])).values()];
}

function ownResourceReferences(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [];
  return Object.entries(record)
    .filter(([key, value]) => typeof value === 'string' &&
      normalizeKey(key).endsWith('resourceid'))
    .map(([field, value]) => ({ field, value: value.trim() }))
    .filter(({ value }) => value);
}

function hasDirectResourceReference(record) {
  return ownResourceReferences(record).length > 0;
}

function collectJsonRecordValues(record, result = {}) {
  if (Array.isArray(record)) {
    for (const item of record) collectJsonRecordValues(item, result);
    return result;
  }
  if (!record || typeof record !== 'object') return result;

  for (const [key, value] of Object.entries(record)) {
    if (value && typeof value === 'object' && hasDirectResourceReference(value)) continue;
    if (value && typeof value === 'object') {
      collectJsonRecordValues(value, result);
    } else if (typeof value === 'string') {
      const text = value.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          collectJsonRecordValues(JSON.parse(text), result);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function jsonRecordScopes(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) jsonRecordScopes(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;

  if (hasDirectResourceReference(value)) {
    result.push(collectJsonRecordValues(value));
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') jsonRecordScopes(child, result);
    else if (typeof child === 'string') {
      const text = child.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          jsonRecordScopes(JSON.parse(text), result);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }
  }
  return result;
}

function parseLogLine(line) {
  const jsonStart = line.indexOf('{');
  let record = {};
  if (jsonStart >= 0) {
    try {
      record = JSON.parse(line.slice(jsonStart));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  const keyValueText = jsonStart >= 0 ? line.slice(0, jsonStart) : line;
  for (const match of keyValueText.matchAll(
    /(?:^|\s)([A-Za-z_][\w.-]*)=((?:"[^"]*")|(?:'[^']*')|[^\s]+)/gu
  )) {
    const key = match[1];
    if (record[key] !== undefined) continue;
    record[key] = match[2].replace(/^["']|["']$/gu, '');
  }

  return record;
}

function logRecordScopes(content) {
  const parsedLines = content.split(/\r?\n/u)
    .map((line, lineNo) => ({ line, lineNo, record: parseLogLine(line) }))
    .filter(({ line }) => line.trim() !== '');
  const grouped = new Map();

  for (const entry of parsedLines) {
    const traceEntry = Object.entries(entry.record).find(([key]) => traceFields.has(normalizeKey(key)));
    const traceId = traceEntry?.[1];
    const groupKey = traceId ? `trace:${traceId}` : `line:${entry.lineNo}`;
    const group = grouped.get(groupKey) ?? [];
    group.push(entry.record);
    grouped.set(groupKey, group);
  }

  return [...grouped.values()].map((records) => ({
    records,
    record: records.length === 1 ? records[0] : records
  }));
}

function sqlRecordScopes(content) {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(content);
    const tableNames = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(({ name }) => name);
    return tableNames.flatMap((tableName) => database.prepare(
      `SELECT * FROM "${tableName.replaceAll('"', '""')}"`
    ).all().map((record) => ({ record, tableName })));
  } finally {
    database.close();
  }
}

function readEvidenceRecords(database) {
  const cached = evidenceIndexCache.get(database);
  if (cached) return cached;

  const metadata = database.prepare(
    'SELECT file_id, file_path, captured_at FROM evidence_files ORDER BY file_id'
  ).all();
  const indexed = [];
  for (const file of metadata) {
    const path = resolve(datasetDirectory, file.file_path);
    const extension = extname(file.file_path).toLowerCase();
    if (!['.json', '.log', '.sql', '.txt'].includes(extension)) continue;

    const content = readFileSync(path, 'utf8');
    let scopes;
    if (extension === '.json') {
      scopes = jsonRecordScopes(JSON.parse(content)).map((record) => ({ record }));
    } else if (extension === '.log') {
      scopes = logRecordScopes(content);
    } else if (extension === '.sql') {
      scopes = sqlRecordScopes(content);
    } else {
      scopes = content.split(/\r?\n/u).map((line) => ({ record: textLineRecord(line) }));
    }

    for (const scope of scopes) {
      const resourceReferences = directResourceReferences(scope.record);
      if (resourceReferences.length === 0) continue;
      indexed.push({
        evidence_id: file.file_id,
        captured_at: file.captured_at,
        file_path: file.file_path,
        location: scope.tableName ?? file.file_path,
        record: scope.record,
        resourceReferences,
        identifiers: allIdentifiersFromRecord(scope.record),
        knownSystemHints: knownSystemHints(scope.record)
      });
    }
  }
  const byIdentifier = new Map();
  for (const row of indexed) {
    for (const { type, value } of row.identifiers) {
      const key = identifierKey(type, value);
      const matchingRows = byIdentifier.get(key) ?? [];
      matchingRows.push(row);
      byIdentifier.set(key, matchingRows);
    }
  }
  const index = { rows: indexed, byIdentifier };
  evidenceIndexCache.set(database, index);
  return index;
}

function knownSystemHints(record) {
  const hints = [];
  const knownFields = new Set([
    'system',
    'systemid',
    'service',
    'sourcesystem',
    'targetsystem',
    'originsystem',
    'origin'
  ]);
  function visit(value) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (knownFields.has(normalizeKey(key)) && typeof child === 'string') hints.push(child);
        if (child && typeof child === 'object') visit(child);
      }
    }
  }
  visit(record);
  return hints;
}

function textLineRecord(line) {
  const record = { line };
  for (const match of line.matchAll(
    /(?:^|[|;,\s])([A-Za-z_][\w.-]*)\s*=\s*((?:"[^"]*")|(?:'[^']*')|[^|;,\s]+)/gu
  )) {
    record[match[1]] = match[2].replace(/^["']|["']$/gu, '');
  }
  const fields = line.split('|').map((field) => field.trim());
  const resourceIndex = fields.findIndex((field, index) => (
    index > 0 &&
    /^[a-z][a-z0-9]*_[a-z0-9-]+$/iu.test(fields[index - 1]) &&
    /^[a-z][a-z0-9]*_[a-z0-9-]+$/iu.test(field) &&
    /^[A-Z][A-Z0-9_]*$/u.test(fields[index + 1] ?? '')
  ));
  if (resourceIndex >= 1 && record.resource_id === undefined) {
    record.system_id = fields[resourceIndex - 1];
    record.resource_id = fields[resourceIndex];
    if (fields[resourceIndex + 1]) record.data_category = fields[resourceIndex + 1];
    if (fields[resourceIndex + 2]) record.state = fields[resourceIndex + 2];
    if (fields[resourceIndex + 3]) record.lookup_key = fields[resourceIndex + 3];
  }
  return record;
}

function resourceTypeCategory(resourceId, categories) {
  const prefix = resourceId.split('_', 1)[0].toLowerCase();
  const candidates = categoryByResourcePrefix[prefix] ?? [];
  return candidates.find((category) => categories.has(category)) ?? null;
}

function categoryForResource(database, systemId, resourceId, categories) {
  const found = database.prepare(
    `SELECT data_category FROM evidence_facts
     WHERE system_id = ? AND resource_id = ? AND data_category IS NOT NULL
     ORDER BY captured_at DESC LIMIT 1`
  ).get(systemId, resourceId)?.data_category;
  return found ?? resourceTypeCategory(resourceId, categories) ?? categoryBySystem[systemId] ?? null;
}

function resolveRequest(database, requestOrCaseId) {
  if (typeof requestOrCaseId === 'string') {
    const request = database.prepare(
      'SELECT case_id, email, audit_at FROM deletion_requests WHERE case_id = ?'
    ).get(requestOrCaseId);
    if (!request) throw new Error(`No deletion request found for ${requestOrCaseId}`);
    return request;
  }
  return requestSchema.parse(requestOrCaseId);
}

export function resolveFootprint(database, requestOrCaseId) {
  const request = resolveRequest(database, requestOrCaseId);
  const identity = resolveIdentity(database, request);
  if (identity.ambiguous || !identity.userId) {
    return { userId: identity.userId, ambiguous: identity.ambiguous, resources: [] };
  }

  const identifiers = identifiersFor(identity);
  const identityKeys = new Set(identifiers.map(({ type, value }) => identifierKey(type, value)));
  const knownCategories = new Set(
    database.prepare('SELECT DISTINCT data_category FROM deletion_rules').all()
      .map((row) => row.data_category)
  );
  const evidenceIndex = readEvidenceFacts(database);
  const activityRows = filterActivityAtOrBefore(
    database.prepare(
      `SELECT activity_id, event_time, event_type, source_system, target_system, resource_id, details
       FROM system_activity
       WHERE resource_id IS NOT NULL`
    ).all(),
    request.audit_at
  );
  const knownSystems = new Set([
    ...database.prepare(
      'SELECT source_system AS system_id FROM system_activity WHERE source_system IS NOT NULL'
    ).all().map(({ system_id }) => system_id),
    ...database.prepare(
      'SELECT target_system AS system_id FROM system_activity WHERE target_system IS NOT NULL'
    ).all().map(({ system_id }) => system_id),
    ...evidenceIndex.facts.map(({ system_id }) => system_id).filter(Boolean)
  ]);

  const resources = new Map();
  const latestEligibleOccurrence = new Map();
  const auditAtMilliseconds = Date.parse(request.audit_at);
  function recordOccurrence(systemId, resourceId, capturedAt) {
    if (!['account_service', 'security_service'].includes(systemId) ||
        !resourceId || !capturedAt || Date.parse(capturedAt) > auditAtMilliseconds) return;
    const key = `${systemId}\u0000${resourceId}`;
    const latestAt = latestEligibleOccurrence.get(key);
    if (!latestAt || Date.parse(capturedAt) > Date.parse(latestAt)) {
      latestEligibleOccurrence.set(key, capturedAt);
    }
  }

  function addResource(
    systemId,
    resourceId,
    dataCategory,
    linkSource,
    evidenceId = null,
    capturedAt = null
  ) {
    if (!systemId || !resourceId) return;
    const key = `${systemId}\u0000${resourceId}`;
    const existing = resources.get(key) ?? {
      system_id: systemId,
      resource_id: resourceId,
      data_category: dataCategory ?? null,
      link_sources: [],
      evidence_ids: [],
      activity_ids: [],
      latestEligibleEvidenceAt: null
    };
    if (!existing.data_category && dataCategory) existing.data_category = dataCategory;
    if (!existing.link_sources.includes(linkSource)) existing.link_sources.push(linkSource);
    if (evidenceId && !existing.evidence_ids.includes(evidenceId)) existing.evidence_ids.push(evidenceId);
    if (evidenceId && capturedAt && isAtOrBefore(capturedAt, request.audit_at) &&
        (!existing.latestEligibleEvidenceAt ||
          Date.parse(capturedAt) > Date.parse(existing.latestEligibleEvidenceAt))) {
      existing.latestEligibleEvidenceAt = capturedAt;
    }
    resources.set(key, existing);
  }

  for (const fact of evidenceIndex.singletonFacts) {
    recordOccurrence(fact.system_id, fact.resource_id, fact.captured_at);
  }

  const matchingFacts = new Set();
  for (const key of identityKeys) {
    for (const fact of evidenceIndex.byIdentifier.get(key) ?? []) {
      matchingFacts.add(fact);
    }
  }
  for (const fact of matchingFacts) {
    addResource(
      fact.system_id,
      fact.resource_id,
      fact.data_category,
      'evidence_identifier',
      fact.evidence_id,
      fact.captured_at
    );
  }

  const activitySystemsByResource = new Map();
  for (const activity of activityRows) {
    const systems = activitySystemsByResource.get(activity.resource_id) ?? [];
    for (const systemId of [activity.target_system, activity.source_system]) {
      if (systemId && !systems.includes(systemId)) systems.push(systemId);
    }
    activitySystemsByResource.set(activity.resource_id, systems);
  }

  function systemForReference(row, reference, includeActivityLinks) {
    const prefixCategory = resourceTypeCategory(reference.value, knownCategories);
    const categorySystem = Object.entries(categoryBySystem)
      .find(([, category]) => category === prefixCategory)?.[0];
    const activitySystem = includeActivityLinks
      ? (activitySystemsByResource.get(reference.value) ?? [])
        .find((systemId) => knownSystems.has(systemId))
      : null;
    const hintedSystem = row.knownSystemHints.find((systemId) => knownSystems.has(systemId));
    return categorySystem ?? activitySystem ?? hintedSystem;
  }

  const structuralIndex = readEvidenceRecords(database);
  for (const row of structuralIndex.rows) {
    for (const reference of row.resourceReferences) {
      const systemId = systemForReference(row, reference, false);
      recordOccurrence(systemId, reference.value, row.captured_at);
    }
  }

  const matchingStructuralRows = new Set();
  for (const key of identityKeys) {
    for (const row of structuralIndex.byIdentifier.get(key) ?? []) {
      matchingStructuralRows.add(row);
    }
  }
  for (const row of matchingStructuralRows) {
    for (const reference of row.resourceReferences) {
      const systemId = systemForReference(row, reference, true);
      if (!systemId) continue;
      const dataCategory = categoryForResource(
        database,
        systemId,
        reference.value,
        knownCategories
      );
      const linkSource = row.file_path.toLowerCase().endsWith('.log')
        ? 'log_trace_identifier'
        : row.file_path.toLowerCase().endsWith('.sql')
          ? 'sql_record_identifier'
          : row.file_path.toLowerCase().endsWith('.txt')
            ? 'handover_line_identifier'
            : 'json_record_identifier';
      addResource(
            systemId,
            reference.value,
            dataCategory,
            linkSource,
            row.evidence_id,
            row.captured_at
      );
    }
  }

  const singletonSystems = new Set(['account_service', 'security_service']);
  const singletonWinners = new Map();
  for (const resource of resources.values()) {
    if (!singletonSystems.has(resource.system_id)) continue;
    resource.latestEligibleEvidenceAt = latestEligibleOccurrence.get(
      `${resource.system_id}\u0000${resource.resource_id}`
    ) ?? null;
    if (!resource.latestEligibleEvidenceAt) continue;
    const current = singletonWinners.get(resource.system_id);
    if (!current || Date.parse(resource.latestEligibleEvidenceAt) >
            Date.parse(current.latestEligibleEvidenceAt) ||
            (resource.latestEligibleEvidenceAt === current.latestEligibleEvidenceAt &&
              resource.resource_id.localeCompare(current.resource_id) > 0)) {
      singletonWinners.set(resource.system_id, resource);
    }
  }

  const selectedResources = [...resources.values()].filter((resource) => {
    if (!singletonSystems.has(resource.system_id)) return true;
    return singletonWinners.get(resource.system_id) === resource;
  });

  for (const resource of selectedResources) {
    resource.activity_ids = activityRows
      .filter((activity) => activity.resource_id === resource.resource_id &&
            (activity.target_system === resource.system_id || activity.source_system === resource.system_id))
      .map((activity) => activity.activity_id);
  }

  return {
    userId: identity.userId,
    ambiguous: false,
    resources: selectedResources.map(({ latestEligibleEvidenceAt, ...resource }) => resource).sort((left, right) => (
      left.system_id.localeCompare(right.system_id) ||
      left.resource_id.localeCompare(right.resource_id)
    ))
  };
}
