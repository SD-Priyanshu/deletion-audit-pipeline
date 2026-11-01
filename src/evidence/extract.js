import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pino from 'pino';
import {
  databasePath as defaultDatabasePath,
  datasetDirectory as defaultDatasetDirectory
} from '../config.js';
import { assertDatasetAvailable, DatasetNotFoundError } from '../dataset.js';

const logger = pino({ name: 'evidence-extractor' });

const IDENTIFIER_KEYS = {
  email: ['email', 'email_address', 'customer_email', 'owner_email', 'requester_email'],
  phone: ['phone', 'phone_number', 'telephone', 'mobile', 'requester_phone', 'customer_phone'],
  email_hash: ['email_hash', 'email_sha256', 'hashed_email'],
  user_id: ['user_id'],
  customer_reference: ['customer_reference', 'customer_ref'],
  subject_reference: ['subject_reference', 'subject_ref'],
  name: ['name', 'full_name', 'requester_name', 'display_name'],
  order_reference: ['order_reference', 'order_ref', 'order_id']
};

const CATEGORY_ALIASES = [
  ['ACCOUNT_TOMBSTONE', /tombstone|deleted_customer_reference/iu],
  ['SUPPORT_ATTACHMENT', /attachment/iu],
  ['SUPPORT_MESSAGE', /support|conversation|message/iu],
  ['SEARCH_INDEX_ENTRY', /search|index_document/iu],
  ['ANALYTICS_PROFILE', /analytics|audience_profile|customer_analytics/iu],
  ['PRODUCT_TELEMETRY', /telemetry|product_event/iu],
  ['USER_EXPORT', /export|download_job/iu],
  ['DATA_FLOW', /connector|subscription|data_flow|webhook/iu],
  ['BACKUP_ARCHIVE', /backup|restore_entry|archive/iu],
  ['SECURITY_AUDIT_LOG', /security|audit_record|audit_log/iu],
  ['LEGAL_HOLD_RECORD', /legal_hold|retained_order/iu],
  ['MARKETING_PROFILE', /marketing|newsletter_profile/iu],
  ['EMAIL_DELIVERY_LOG', /email_delivery|delivery_log|notification/iu],
  ['CACHE_ENTRY', /cache/iu],
  ['SECONDARY_IDENTIFIER', /secondary_identifier|identity_alias/iu],
  ['USER_PROFILE', /customer_profile|user_profile|account_profile/iu]
];

const CATEGORY_SYSTEMS = {
  ACCOUNT_TOMBSTONE: 'identity_service',
  BACKUP_ARCHIVE: 'backup_service',
  CACHE_ENTRY: 'cache_service',
  DATA_FLOW: 'integration_service',
  EMAIL_DELIVERY_LOG: 'email_delivery_service',
  LEGAL_HOLD_RECORD: 'legal_service',
  MARKETING_PROFILE: 'marketing_platform',
  PRODUCT_TELEMETRY: 'analytics_platform',
  SEARCH_INDEX_ENTRY: 'search_service',
  SECURITY_AUDIT_LOG: 'security_service',
  SUPPORT_ATTACHMENT: 'support_platform',
  SUPPORT_MESSAGE: 'support_platform',
  USER_EXPORT: 'export_service',
  USER_PROFILE: 'account_service',
  ANALYTICS_PROFILE: 'analytics_platform',
  SECONDARY_IDENTIFIER: 'identity_service'
};

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function nonEmpty(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' || text.toLowerCase() === 'null' ? null : text;
}

function lookupValue(record, candidateKeys) {
  const desired = new Set(candidateKeys.map(normalizeKey));
  for (const [key, value] of Object.entries(record ?? {})) {
    if (desired.has(normalizeKey(key)) && nonEmpty(value) !== null) {
      return nonEmpty(value);
    }
  }
  return null;
}

function getIdentifiers(record) {
  const identifiers = Object.fromEntries(
    Object.entries(IDENTIFIER_KEYS).map(([field, aliases]) => [field, lookupValue(record, aliases)])
  );
  for (const key of ['lookup_key', 'match_key', 'subject_key', 'correlation_key', 'matched_value']) {
    const value = lookupValue(record, [key]);
    if (!value) continue;
    if (value.includes('@') && !identifiers.email) identifiers.email = value;
    else if (/^user_[\p{L}\p{N}_-]+$/iu.test(value) && !identifiers.user_id) identifiers.user_id = value;
    else if (/^[a-f\d]{64}$/iu.test(value) && !identifiers.email_hash) identifiers.email_hash = value;
    else if (/^\+?[\d().\s-]{7,}$/u.test(value) && !identifiers.phone) identifiers.phone = value;
  }
  for (const field of ['customer_reference', 'subject_reference']) {
    if (/^user_[\p{L}\p{N}_-]+$/iu.test(identifiers[field] ?? '') && !identifiers.user_id) {
      identifiers.user_id = identifiers[field];
    }
  }
  return identifiers;
}

function mergeRecord(outer, embedded) {
  return { ...(outer ?? {}), ...(embedded ?? {}) };
}

function resolveCategory(record, structuralHints, categories) {
  const knownCategories = [...categories, 'DATA_FLOW'];
  const known = new Map(knownCategories.map((category) => [normalizeKey(category), category]));
  const explicit = [
    lookupValue(record, ['data_category', 'category', 'record_type', 'resource_type']),
    ...structuralHints
  ].filter(Boolean);

  for (const hint of explicit) {
    const category = known.get(normalizeKey(hint));
    if (category) return category;
  }

  const resourceId = lookupValue(record, ['resource_id', 'resource']);
  const prefix = resourceId?.split('_', 1)[0]?.toLowerCase();
  const event = normalizeKey(lookupValue(record, ['event', 'event_type', 'operation']));
  const keys = new Set(Object.keys(record ?? {}).map(normalizeKey));
  const hintKeys = new Set(structuralHints.map(normalizeKey));

  if (event === 'contactlookupcompleted' || keys.has('emailoptin')) {
    return known.get(normalizeKey('MARKETING_PROFILE')) ?? null;
  }
  if (event.startsWith('analyticsprofileread') || keys.has('audiencecohort')) {
    return known.get(normalizeKey('ANALYTICS_PROFILE')) ?? null;
  }

  if (prefix === 'support') {
    if (event === 'messagepiiscan' ||
        keys.has('messageexcerpt') ||
        keys.has('messagetext') ||
        hintKeys.has('ticket') ||
        (keys.has('requesteremail') &&
          (keys.has('ticketid') || keys.has('channel') || event.includes('ticket')))) {
      return known.get(normalizeKey('SUPPORT_MESSAGE')) ?? null;
    }
    if (event === 'attachmentpiiscan' ||
        event.includes('upload') ||
        keys.has('uploadedfile') ||
        ((keys.has('file') || keys.has('filename')) &&
          (keys.has('uploader') || keys.has('uploadedby') || keys.has('uploadedat')))) {
      return known.get(normalizeKey('SUPPORT_ATTACHMENT')) ?? null;
    }
    return known.get(normalizeKey('SUPPORT_ATTACHMENT')) ?? null;
  }

  const context = [...explicit, resourceId, ...Object.keys(record ?? {})].filter(Boolean).join(' ');
  for (const [category, pattern] of CATEGORY_ALIASES) {
    if (known.has(normalizeKey(category)) && pattern.test(context)) return category;
  }

  const prefixCategory = {
    account: 'USER_PROFILE',
    analytics: 'ANALYTICS_PROFILE',
    audit: 'SECURITY_AUDIT_LOG',
    backup: 'BACKUP_ARCHIVE',
    cache: 'CACHE_ENTRY',
    data: 'DATA_FLOW',
    export: 'USER_EXPORT',
    legal: 'LEGAL_HOLD_RECORD',
    search: 'SEARCH_INDEX_ENTRY',
    support: 'SUPPORT_ATTACHMENT',
    tombstone: 'ACCOUNT_TOMBSTONE'
  }[prefix];
  return prefixCategory && known.has(normalizeKey(prefixCategory)) ? prefixCategory : null;
}

function resolveSystem(record, category, knownSystems, structuralHints = []) {
  const explicit = lookupValue(record, [
    'system_id', 'system', 'source_system', 'target_system', 'origin_system', 'service'
  ]);
  if (explicit && knownSystems.has(explicit)) return explicit;

  for (const hint of structuralHints) {
    if (knownSystems.has(hint)) return hint;
  }
  const candidate = CATEGORY_SYSTEMS[category];
  return candidate && knownSystems.has(candidate) ? candidate : explicit;
}

function mapTextState(value) {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/gu, '_');
  const mapping = {
    ABSENT: 'ABSENT',
    ANONYMIZED: 'ANONYMIZED',
    ACTIVE: 'ACTIVE',
    BLOCKED: 'BLOCKED',
    DISABLED: 'DISABLED',
    FOUND: 'PRESENT',
    IDENTIFIABLE: 'PRESENT',
    NOT_FOUND: 'ABSENT',
    PRESENT: 'PRESENT',
    REDACTED: 'REDACTED',
    RESTORABLE: 'RESTORABLE'
  };
  return mapping[normalized] ?? null;
}

function inferState(record, category, systemId, { defaultPresent = false } = {}) {
  const httpStatus = Number(lookupValue(record, ['http_status', 'status_code']));
  if (systemId === 'account_service' && httpStatus === 404) return 'ABSENT';
  if (systemId === 'account_service' && httpStatus === 200) return 'PRESENT';

  const event = (lookupValue(record, ['event', 'event_type', 'operation']) ?? '').toLowerCase();
  if (event.endsWith('_started')) return null;
  const matched = lookupValue(record, ['matched_value']);
  const matches = lookupValue(record, ['matches']);
  if (event === 'message_pii_scan' && (matched || (matches && Number(matches) > 0))) return 'PRESENT';

  const hasDirectIdentityFields = ['name', 'email', 'phone', 'email_hash'].some((field) => (
    Object.keys(record ?? {}).some((key) => IDENTIFIER_KEYS[field].some(
      (alias) => normalizeKey(key) === normalizeKey(alias)
    ))
  ));
  if (
    ['SUPPORT_MESSAGE', 'SUPPORT_ATTACHMENT'].includes(category) &&
    hasDirectIdentityFields &&
    ['name', 'email', 'phone', 'email_hash'].every((field) => (
      lookupValue(record, IDENTIFIER_KEYS[field]) === null
    ))
  ) {
    return 'REDACTED';
  }

  const deletionBlock = lookupValue(record, ['deletion_block']);
  const restoreAllowed = lookupValue(record, ['restore_allowed']);
  const eligible = lookupValue(record, ['eligible']);
  if (deletionBlock !== null && /^(?:true|1|yes)$/iu.test(deletionBlock)) return 'BLOCKED';
  if (restoreAllowed !== null) {
    if (/^(?:true|1|yes)$/iu.test(restoreAllowed)) return 'RESTORABLE';
    if (/^(?:false|0|no)$/iu.test(restoreAllowed)) return 'BLOCKED';
  }
  if (
    event === 'restore_candidate_evaluated' &&
    /^(?:true|1|yes)$/iu.test(eligible ?? '') &&
    /^(?:false|0|no)$/iu.test(deletionBlock ?? '')
  ) {
    return 'RESTORABLE';
  }

  const enabled = lookupValue(record, ['enabled']);
  if (category === 'DATA_FLOW' && enabled !== null) {
    if (/^(?:true|1|yes)$/iu.test(enabled)) return 'ACTIVE';
    if (/^(?:false|0|no)$/iu.test(enabled)) return 'DISABLED';
  }

  if (systemId === 'search_service') {
    const result = (lookupValue(record, ['result']) ?? '').toLowerCase();
    if (result === 'hit' || result === 'found') return 'PRESENT';
    if (result === 'miss' || result === 'not_found') return 'ABSENT';
  }
  const rowCount = lookupValue(record, ['rows']);
  if (
    event.endsWith('_completed') &&
    ((rowCount !== null && Number(rowCount) > 0) ||
      Object.values(getIdentifiers(record)).some((value) => value !== null))
  ) {
    return 'PRESENT';
  }

  const explicitState = ['state', 'status', 'result', 'record_status']
    .map((key) => mapTextState(lookupValue(record, [key])))
    .find(Boolean);
  if (explicitState === 'ABSENT') return 'ABSENT';

  if (category === 'ACCOUNT_TOMBSTONE') {
    const pii = ['name', 'email', 'phone', 'email_hash'].some((field) => (
      lookupValue(record, IDENTIFIER_KEYS[field]) !== null
    ));
    return pii ? 'PRESENT' : 'REDACTED';
  }

  const identityFields = ['user_id', 'email', 'phone', 'email_hash'];
  const hasIdentityField = identityFields.every((field) => (
    Object.keys(record ?? {}).some((key) => (
      normalizeKey(key) === normalizeKey(field) ||
      (field === 'user_id' && normalizeKey(key) === normalizeKey('customer_reference'))
    ))
  ));
  const isUnlinked = identityFields.every((field) => lookupValue(record, IDENTIFIER_KEYS[field]) === null);
  if (
    (hasIdentityField && isUnlinked) ||
    (
      ['ANALYTICS_PROFILE', 'PRODUCT_TELEMETRY'].includes(category) &&
      isUnlinked &&
      lookupValue(record, ['customer_reference', 'subject_reference']) === null
    )
  ) {
    if (category === 'ANALYTICS_PROFILE' || category === 'PRODUCT_TELEMETRY') return 'ANONYMIZED';
  }

  if (explicitState) return explicitState;

  for (const key of ['state', 'status', 'result', 'record_status']) {
    const value = lookupValue(record, [key]);
    const state = mapTextState(value);
    if (state) return state;
  }

  return defaultPresent ? 'PRESENT' : null;
}

function makeFact({
  evidenceId,
  systemId,
  resourceId,
  dataCategory,
  state,
  location,
  identifiers,
  capturedAt,
  record
}) {
  return {
    case_id: null,
    user_id: identifiers.user_id,
    resource_id: resourceId,
    system_id: systemId,
    data_category: dataCategory,
    state,
    evidence_id: evidenceId,
    captured_at: capturedAt,
    fact_json: JSON.stringify(record),
    location,
    identifiers: JSON.stringify(identifiers)
  };
}

function parseKeyValueLine(line) {
  const jsonStart = line.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(line.slice(jsonStart));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  const fields = {};
  const messageMatch = line.match(/\bmessage="(.*)"\s*$/u);
  const outerLine = messageMatch ? line.slice(0, messageMatch.index) : line;
  const pattern = /([A-Za-z][A-Za-z0-9_.-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/gu;
  for (const match of outerLine.matchAll(pattern)) {
    fields[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  if (messageMatch) {
    const message = messageMatch[1].replaceAll('\\"', '"');
    for (const match of message.matchAll(pattern)) {
      fields[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  const bracketFields = [...line.matchAll(/\[([^\]]+)\]/gu)].map((match) => match[1]);
  const event = line.match(/\b([a-z][a-z0-9_]+):\s*(?:instance=|resource_id=)/iu)?.[1];
  if (event && !fields.event) fields.event = event;
  if (!fields.service && bracketFields.length >= 2) fields.service = bracketFields[1];
  return fields;
}

function extractLogFacts(content, metadata, categories, knownSystems, coveredSystems) {
  const facts = [];
  for (const line of content.split(/\r?\n/u)) {
    const record = parseKeyValueLine(line);
    const resourceId = lookupValue(record, ['resource_id', 'resource']);
    const category = resolveCategory(record, [], categories);
    const systemId = resolveSystem(record, category, knownSystems);
    if (systemId && knownSystems.has(systemId)) coveredSystems.add(systemId);
    if (!resourceId) continue;
    const state = inferState(record, category, systemId);
    if (!state) continue;

    const identifiers = getIdentifiers(record);
    facts.push(makeFact({
      evidenceId: metadata.file_id,
      systemId,
      resourceId,
      dataCategory: category,
      state,
      location: metadata.origin,
      identifiers,
      capturedAt: metadata.captured_at,
      record
    }));
  }
  return facts;
}

function extractTextFacts(content, metadata, categories, knownSystems, coveredSystems) {
  const facts = [];
  for (const line of content.split(/\r?\n/u)) {
    const columns = line.replace(/^\s*[-*]\s*/u, '').split('|').map((value) => value.trim());
    if (columns.length < 6 || !/^\d{4}-\d{2}-\d{2}T/u.test(columns[0])) continue;
    const [eventTime, systemId, resourceId, dataCategoryRaw, status, identifier] = columns;
    if (!resourceId) continue;
    if (knownSystems.has(systemId)) coveredSystems.add(systemId);

    const record = {
      event_time: eventTime,
      system_id: systemId,
      resource_id: resourceId,
      data_category: dataCategoryRaw,
      status,
      identifier
    };
    const category = resolveCategory(record, [dataCategoryRaw], categories);
    const normalizedIdentifier = nonEmpty(identifier);
    const identifiers = getIdentifiers({
      ...record,
      ...(normalizedIdentifier?.includes('@') ? { email: normalizedIdentifier } : {}),
      ...(normalizedIdentifier && /^user_/iu.test(normalizedIdentifier) ? { user_id: normalizedIdentifier } : {})
    });
    const state = mapTextState(status);
    if (!knownSystems.has(systemId) || !state) continue;

    facts.push(makeFact({
      evidenceId: metadata.file_id,
      systemId,
      resourceId,
      dataCategory: category,
      state,
      location: metadata.origin,
      identifiers,
      capturedAt: metadata.captured_at,
      record
    }));
  }
  return facts;
}

function extractPdfFacts(content, metadata, categories, knownSystems, coveredSystems) {
  const facts = [];
  const extractNames = (text) => [
    ...[...text.matchAll(
      /\b(?:Customer|Requester|Subject|Name)\s+([A-Z][\p{L}'’-]+\s+[A-Z][\p{L}'’-]+)\b/gu
    )].map(([, name]) => name),
    ...[...text.matchAll(
      /\bDetail\s+([A-Z][\p{L}'’-]+\s+[A-Z][\p{L}'’-]+)\s+Detail\s+[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu
    )].map(([, name]) => name)
  ];
  const addPdfFact = (record, resourceId, context) => {
    const enriched = { ...record, resource_id: resourceId };
    const category = resolveCategory(enriched, [context], categories);
    const systemId = resolveSystem(enriched, category, knownSystems, [context]);
    if (!category || !systemId || !knownSystems.has(systemId)) return;
    coveredSystems.add(systemId);
    const resourceContext = resourceId && new Set(
      [...content.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[0-9]+\b/giu)]
        .map(([value]) => value)
        .filter((value) => !/^user_/iu.test(value))
    ).size === 1 ? content : context;
    const uploadedFile = resourceContext.match(
      /\b(?:file|attachment)\s+([A-Z0-9][A-Z0-9_.-]+\.[A-Z0-9]{2,5})\b/iu
    )?.[1] ?? null;
    const normalizedRecord = {
      ...enriched,
      ...(uploadedFile ? { attachment_indicator: true, uploaded_file: uploadedFile } : {}),
      ...(record.retention_until ? { retention_until: record.retention_until } : {}),
      ...(record.order_reference ? { order_reference: record.order_reference } : {})
    };
    facts.push(makeFact({
      evidenceId: metadata.file_id,
      systemId,
      resourceId,
      dataCategory: category,
      state: inferState(normalizedRecord, category, systemId, { defaultPresent: true }) ?? 'PRESENT',
      location: metadata.origin,
      identifiers: getIdentifiers(normalizedRecord),
      capturedAt: metadata.captured_at,
      record: normalizedRecord
    }));
  };

  const legalEntry = /\b(?<order>ORD-[A-Z0-9-]+)\s*\|\s*(?<user>user_[\p{L}\p{N}_-]+)\s*\|\s*(?<reason>[^|]+)\|\s*(?<entryDate>\d{1,2}\s+[A-Z][a-z]+\s+\d{4})\s*\|\s*(?<amount>[^|]+)\|\s*Retain\s+until\s+(?<retention>[^|]+)/giu;
  const legalEntries = [...content.matchAll(legalEntry)].map(({ groups }) => ({
    order_reference: groups.order,
    user_id: groups.user,
    entry_reason: groups.reason.trim(),
    entry_date: groups.entryDate,
    retention_until: groups.retention.trim()
  }));
  if (legalEntries.length > 0) {
    const systemId = 'legal_service';
    if (knownSystems.has(systemId)) coveredSystems.add(systemId);
    facts.push(makeFact({
      evidenceId: metadata.file_id,
      systemId,
      resourceId: null,
      dataCategory: 'LEGAL_HOLD_RECORD',
      state: 'PRESENT',
      location: metadata.origin,
      identifiers: {
        email: null,
        phone: null,
        email_hash: null,
        user_id: null,
        customer_reference: null,
        subject_reference: null,
        name: null,
        order_references: legalEntries.map(({ order_reference }) => order_reference),
        user_ids: legalEntries.map(({ user_id }) => user_id)
      },
      capturedAt: metadata.captured_at,
      record: { legal_register_entries: legalEntries }
    }));
  }

  const resourcePattern = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[0-9]+\b/giu;
  const resourceMatches = [...content.matchAll(resourcePattern)]
    .filter((match) => !/^user_/iu.test(match[0]));
  const resourceIds = new Set(resourceMatches.map(({ 0: resourceId }) => resourceId));
  for (const resourceId of resourceIds) {
    const contexts = resourceMatches
      .filter((match) => match[0] === resourceId)
      .map((match) => content.slice(Math.max(0, match.index - 180), match.index + resourceId.length + 280));
    const context = contexts.join(' ');
    const identifierContext = resourceIds.size === 1 ? content : context;
    const emails = [...identifierContext.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)]
      .map(([email]) => email);
    const phones = [...identifierContext.matchAll(/\+\d[\d ().-]{5,}\d/gu)].map(([phone]) => phone.trim());
    const userIds = [...identifierContext.matchAll(/\buser_[\p{L}\p{N}_-]+\b/giu)]
      .map(([userId]) => userId);
    const orderReferences = [...identifierContext.matchAll(/\bORD-[A-Z0-9-]+\b/giu)]
      .map(([orderReference]) => orderReference);
    const names = extractNames(identifierContext);
    const retentionUntil = identifierContext.match(
      /\b(?:retain(?:ed)?\s+until|retention(?:\s+expires?)?\s*:?)\s+(\d{1,2}\s+[A-Z][a-z]+\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+UTC)?)?)/iu
    )?.[1] ?? null;
    const record = {
      ...(emails[0] ? { email: emails[0] } : {}),
      ...(phones[0] ? { phone: phones[0] } : {}),
      ...(userIds[0] ? { user_id: userIds[0] } : {}),
      ...(names[0] ? { name: names[0] } : {}),
      ...(orderReferences[0] ? { order_reference: orderReferences[0] } : {}),
      ...(retentionUntil ? { retention_until: retentionUntil } : {})
    };
    addPdfFact(record, resourceId, context);
  }

  if (facts.length === 0) {
    const emails = [...content.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)]
      .map(([email]) => email);
    const phones = [...content.matchAll(/\+\d[\d ().-]{5,}\d/gu)].map(([phone]) => phone.trim());
    const userIds = [...content.matchAll(/\buser_[\p{L}\p{N}_-]+\b/giu)]
      .map(([userId]) => userId);
    const orderReferences = [...content.matchAll(/\bORD-[A-Z0-9-]+\b/giu)]
      .map(([orderReference]) => orderReference);
    const names = extractNames(content);
    const identifiers = {
      email: emails[0] ?? null,
      phone: phones[0] ?? null,
      email_hash: null,
      user_id: userIds[0] ?? null,
      customer_reference: null,
      subject_reference: null,
      name: names[0] ?? null,
      order_references: [...new Set(orderReferences)]
    };
    if (Object.values(identifiers).some((value) => (
      Array.isArray(value) ? value.length > 0 : value !== null
    ))) {
      facts.push(makeFact({
        evidenceId: metadata.file_id,
        systemId: null,
        resourceId: null,
        dataCategory: null,
        state: 'PRESENT',
        location: metadata.origin,
        identifiers,
        capturedAt: metadata.captured_at,
        record: { document_identifiers: identifiers }
      }));
    }
  }
  return facts;
}

async function extractPdfText(path) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    useSystemFonts: true
  });
  try {
    const document = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    return pages.join('\n');
  } finally {
    await loadingTask.destroy();
  }
}

function collectJsonObjects(value, structuralHints = [], result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonObjects(item, structuralHints, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;

  const nextHints = [
    ...structuralHints,
    ...['system', 'system_id', 'origin_system', 'data_store', 'collection', 'collection_name']
      .map((key) => nonEmpty(value[key]))
      .filter(Boolean)
  ];
  if (nonEmpty(value.resource_id ?? value.resourceId)) {
    result.push({ record: value, structuralHints: nextHints });
  }

  for (const [key, child] of Object.entries(value)) {
    const childHints = normalizeKey(key) === 'tickets'
      ? [...nextHints, 'ticket']
      : nextHints;
    if (typeof child === 'string' && child.trim().startsWith('{')) {
      try {
        collectJsonObjects(JSON.parse(child), childHints, result);
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
    } else if (child && typeof child === 'object') {
      collectJsonObjects(child, childHints, result);
    }
  }
  return result;
}

function collectJsonSystems(value, knownSystems, systems = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonSystems(item, knownSystems, systems);
    return systems;
  }
  if (!value || typeof value !== 'object') return systems;

  const systemFields = new Set(['system', 'systemid', 'originsystem', 'datastore', 'service']);
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
    if (systemFields.has(normalizedKey) || normalizedKey === 'systems') {
      const candidates = Array.isArray(child) ? child : [child];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && knownSystems.has(candidate.trim())) {
          systems.add(candidate.trim());
        }
      }
    }
    if (child && typeof child === 'object') {
      collectJsonSystems(child, knownSystems, systems);
    }
  }
  return systems;
}

function extractJsonFacts(content, metadata, categories, knownSystems, coveredSystems) {
  const parsed = JSON.parse(content);
  for (const systemId of collectJsonSystems(parsed, knownSystems)) {
    coveredSystems.add(systemId);
  }
  return collectJsonObjects(parsed).flatMap(({ record, structuralHints }) => {
    const resourceId = lookupValue(record, ['resource_id', 'resource']);
    const category = resolveCategory(record, structuralHints, categories);
    const systemId = resolveSystem(record, category, knownSystems, structuralHints);
    if (systemId && knownSystems.has(systemId)) coveredSystems.add(systemId);
    const state = inferState(record, category, systemId, { defaultPresent: true });
    if (!resourceId || !state) return [];

    return [makeFact({
      evidenceId: metadata.file_id,
      systemId,
      resourceId,
      dataCategory: category,
      state,
      location: metadata.origin,
      identifiers: getIdentifiers(record),
      capturedAt: metadata.captured_at,
      record
    })];
  });
}

function resolveEmbeddedRecord(row) {
  const raw = lookupValue(row, ['record_json']);
  if (!raw) return row;
  try {
    const embedded = JSON.parse(raw);
    return embedded && typeof embedded === 'object' && !Array.isArray(embedded)
      ? mergeRecord(row, embedded)
      : row;
  } catch (error) {
    throw new Error(`Invalid record_json for resource ${row.resource_id ?? '(no resource_id)'}`, { cause: error });
  }
}

function normalizeTableName(name) {
  return name.toLowerCase()
    .replace(/_primary$/u, '')
    .replace(/_(?:failover|read|reporting)_replica$/u, '')
    .replace(/_replica_[a-z0-9_]+$/u, '')
    .replace(/_replicas$/u, '')
    .replace(/_replica$/u, '');
}

function extractSqlFacts(content, metadata, categories, knownSystems, coveredSystems) {
  const database = new DatabaseSync(':memory:');
  const facts = [];
  try {
    database.exec(content);
    const tableNames = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((row) => row.name);
    const rowsByTable = new Map();

    for (const tableName of tableNames) {
      const rows = database.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
      const enrichedRows = rows.map((rawRow) => resolveEmbeddedRecord(rawRow));
      rowsByTable.set(tableName, enrichedRows);
      const structuralCategory = resolveCategory({}, [tableName], categories);
      const structuralSystem = resolveSystem({}, structuralCategory, knownSystems, [tableName]);
      if (structuralSystem && knownSystems.has(structuralSystem)) coveredSystems.add(structuralSystem);
      for (const record of enrichedRows) {
        const resourceId = lookupValue(record, ['resource_id', 'resource']);
        if (!resourceId) continue;
        const structuralHints = [
          tableName,
          lookupValue(record, ['collection_name', 'collection', 'data_category'])
        ].filter(Boolean);
        const category = resolveCategory(record, structuralHints, categories);
        const systemId = resolveSystem(record, category, knownSystems, structuralHints);
        if (systemId && knownSystems.has(systemId)) coveredSystems.add(systemId);
        const state = inferState(record, category, systemId, { defaultPresent: true });
        facts.push(makeFact({
          evidenceId: metadata.file_id,
          systemId,
          resourceId,
          dataCategory: category,
          state,
          location: tableName,
          identifiers: getIdentifiers(record),
          capturedAt: metadata.captured_at,
          record
        }));
      }
    }

    if (tableNames.includes('snapshot_scope')) {
      for (const scope of database.prepare('SELECT * FROM snapshot_scope').all()) {
        const systemId = lookupValue(scope, ['origin_system', 'system', 'system_id']);
        if (systemId && knownSystems.has(systemId)) coveredSystems.add(systemId);
      }
    }

    const primaryTables = tableNames.filter((name) => /(?:^|_)primary$/iu.test(name));
    const replicaTables = tableNames.filter((name) => /(?:replica|replicas)/iu.test(name) && !/(?:^|_)primary$/iu.test(name));
    for (const replicaTable of replicaTables) {
      const normalizedReplica = normalizeTableName(replicaTable);
      const candidatePrimary = primaryTables.find((name) => normalizeTableName(name) === normalizedReplica);
      if (!candidatePrimary) continue;

      const primaryRows = rowsByTable.get(candidatePrimary) ?? [];
      const primaryResourceIds = new Set(primaryRows.map((row) => lookupValue(row, ['resource_id', 'resource'])).filter(Boolean));
      for (const record of rowsByTable.get(replicaTable) ?? []) {
        const resourceId = lookupValue(record, ['resource_id', 'resource']);
        if (!resourceId || primaryResourceIds.has(resourceId)) continue;
        const structuralHints = [
          replicaTable,
          lookupValue(record, ['collection_name', 'collection', 'data_category'])
        ].filter(Boolean);
        const category = resolveCategory(record, structuralHints, categories);
        const systemId = resolveSystem(record, category, knownSystems, structuralHints);
        facts.push(makeFact({
          evidenceId: metadata.file_id,
          systemId,
          resourceId,
          dataCategory: category,
          state: 'ABSENT',
          location: candidatePrimary,
          identifiers: getIdentifiers(record),
          capturedAt: metadata.captured_at,
          record: { resource_id: resourceId, inferred_from_replica: replicaTable }
        }));
      }
    }
  } finally {
    database.close();
  }
  return facts;
}

function ensureEvidenceFactColumns(database) {
  const existing = new Set(database.prepare('PRAGMA table_info(evidence_facts)').all().map((column) => column.name));
  for (const [column, type] of [['location', 'TEXT'], ['identifiers', 'TEXT']]) {
    if (!existing.has(column)) {
      database.exec(`ALTER TABLE evidence_facts ADD COLUMN ${quoteIdentifier(column)} ${type}`);
    }
  }
}

function isWithinDirectory(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export async function runEvidenceExtraction({
  databasePath = defaultDatabasePath,
  datasetDirectory = defaultDatasetDirectory,
  output = console
} = {}) {
  assertDatasetAvailable(datasetDirectory);
  const database = new DatabaseSync(databasePath);
  try {
    ensureEvidenceFactColumns(database);
    const categories = database.prepare(
      'SELECT DISTINCT data_category FROM deletion_rules WHERE data_category IS NOT NULL'
    ).all().map((row) => row.data_category);
    const knownSystems = new Set([
      ...database.prepare('SELECT source_system AS system FROM system_activity WHERE source_system IS NOT NULL').all().map((row) => row.system),
      ...database.prepare('SELECT target_system AS system FROM system_activity WHERE target_system IS NOT NULL').all().map((row) => row.system),
      ...Object.values(CATEGORY_SYSTEMS)
    ]);
    const manifest = database.prepare(
      'SELECT file_id, file_path, origin, captured_at FROM evidence_files ORDER BY file_id'
    ).all();
    const insertFact = database.prepare(
      `INSERT INTO evidence_facts
       (case_id, user_id, resource_id, system_id, data_category, state, evidence_id,
        captured_at, fact_json, location, identifiers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    database.exec(`CREATE TABLE IF NOT EXISTS evidence_coverage (
      coverage_id INTEGER PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      system_id TEXT NOT NULL,
      captured_at TEXT NOT NULL
    )`);
    const insertCoverage = database.prepare(
      'INSERT INTO evidence_coverage (evidence_id, system_id, captured_at) VALUES (?, ?, ?)'
    );

    database.exec('BEGIN');
    try {
      database.exec('DELETE FROM evidence_facts');
      database.exec('DELETE FROM evidence_coverage');
      const factsByType = new Map();
      const filesByType = new Map();
      const factsBySystem = new Map();
      const factsByState = new Map();
      const zeroFactFiles = [];
      let totalFacts = 0;

      for (const metadata of manifest) {
        const path = resolve(datasetDirectory, metadata.file_path);
        if (!isWithinDirectory(datasetDirectory, path)) {
          throw new Error(`Evidence path escapes the dataset directory: ${metadata.file_path}`);
        }
        const extension = extname(path).toLowerCase();
        if (!['.sql', '.json', '.log', '.txt', '.pdf'].includes(extension)) continue;
        filesByType.set(extension, (filesByType.get(extension) ?? 0) + 1);
        const content = await readFile(path, 'utf8');
        const coveredSystems = new Set();
        let facts;
        if (extension === '.sql') {
          facts = extractSqlFacts(content, metadata, categories, knownSystems, coveredSystems);
        } else if (extension === '.json') {
          facts = extractJsonFacts(content, metadata, categories, knownSystems, coveredSystems);
        } else if (extension === '.log') {
          facts = extractLogFacts(content, metadata, categories, knownSystems, coveredSystems);
        } else if (extension === '.pdf') {
          const pdfText = await extractPdfText(path);
          facts = extractPdfFacts(pdfText, metadata, categories, knownSystems, coveredSystems);
        } else {
          facts = extractTextFacts(content, metadata, categories, knownSystems, coveredSystems);
        }

        if (facts.length === 0) {
          zeroFactFiles.push(metadata);
          logger.warn(
            { evidence_id: metadata.file_id, file_path: metadata.file_path },
            'Evidence file produced zero facts'
          );
        }
        factsByType.set(extension, (factsByType.get(extension) ?? 0) + facts.length);
        for (const systemId of coveredSystems) {
          if (extension !== '.log') {
            insertCoverage.run(metadata.file_id, systemId, metadata.captured_at);
          }
        }
        for (const fact of facts) {
          insertFact.run(
            fact.case_id,
            fact.user_id,
            fact.resource_id,
            fact.system_id,
            fact.data_category,
            fact.state,
            fact.evidence_id,
            fact.captured_at,
            fact.fact_json,
            fact.location,
            fact.identifiers
          );
          factsBySystem.set(fact.system_id ?? '(unknown)', (factsBySystem.get(fact.system_id ?? '(unknown)') ?? 0) + 1);
          factsByState.set(fact.state, (factsByState.get(fact.state) ?? 0) + 1);
        }
        totalFacts += facts.length;
      }
      database.exec('COMMIT');

      const summary = {
        totalFacts,
        filesByType: Object.fromEntries([...filesByType].sort(([a], [b]) => a.localeCompare(b))),
        factsByFileType: Object.fromEntries([...factsByType].sort(([a], [b]) => a.localeCompare(b))),
        perSystemId: Object.fromEntries([...factsBySystem].sort(([a], [b]) => a.localeCompare(b))),
        perState: Object.fromEntries([...factsByState].sort(([a], [b]) => a.localeCompare(b))),
        zeroFactFiles: zeroFactFiles.map(({ file_id, file_path }) => ({ file_id, file_path }))
      };
      output.log(JSON.stringify(summary, null, 2));
      return summary;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runEvidenceExtraction().catch((error) => {
    if (error instanceof DatasetNotFoundError) {
      console.error(error.message);
    } else {
      logger.error({ err: error }, 'Evidence extraction failed');
    }
    process.exitCode = 1;
  });
}
