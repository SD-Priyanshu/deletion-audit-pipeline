import { createHash } from 'node:crypto';
import { z } from 'zod';
import { filterRowsAtOrBefore } from './time.js';

const requestSchema = z.object({
  email: z.string().trim().min(1),
  audit_at: z.string().min(1)
});

function normalizedEmail(value) {
  return value.trim().toLowerCase();
}

function normalizedValue(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function addUnique(values, value) {
  const normalized = normalizedValue(value);
  if (normalized !== null && !values.includes(normalized)) {
    values.push(normalized);
  }
}

function addEmail(values, value) {
  if (typeof value === 'string' && value.trim() !== '') {
    addUnique(values, normalizedEmail(value));
  }
}

function addEmailHash(values, value) {
  if (typeof value === 'string' && value.trim() !== '') {
    addUnique(values, value.trim().toLowerCase());
  }
}

function emailHash(email) {
  return createHash('sha256').update(normalizedEmail(email), 'utf8').digest('hex');
}

function findUserIds(database, email, auditAt) {
  const currentMatches = database.prepare(
    'SELECT user_id FROM user_identities WHERE lower(trim(email)) = ? ORDER BY user_id'
  ).all(email).map((row) => row.user_id);
  if (currentMatches.length > 0) {
    return [...new Set(currentMatches)];
  }

  const historicalRows = database.prepare(
    `SELECT user_id, event_time, old_value, new_value
     FROM user_audit_log
     WHERE field_name = 'email'
       AND (lower(trim(old_value)) = ? OR lower(trim(new_value)) = ?)`
  ).all(email, email);
  return [...new Set(
    filterRowsAtOrBefore(historicalRows, 'event_time', auditAt).map((row) => row.user_id)
  )].sort();
}

export function resolveIdentity(database, request) {
  const parsedRequest = requestSchema.parse(request);
  const email = normalizedEmail(parsedRequest.email);
  const userIds = findUserIds(database, email, parsedRequest.audit_at);
  const ambiguous = userIds.length > 1;
  const userId = userIds.length === 1 ? userIds[0] : null;
  const identifiers = { emails: [], phones: [], emailHashes: [], names: [] };

  if (userId === null) {
    return { userId, identifiers, ambiguous };
  }

  addEmail(identifiers.emails, email);

  const identity = database.prepare(
    `SELECT name, email, phone, email_hash, updated_at
     FROM user_identities
     WHERE user_id = ?
     ORDER BY updated_at DESC
     LIMIT 1`
  ).get(userId);

  const auditRows = database.prepare(
    `SELECT event_time, field_name, old_value, new_value
     FROM user_audit_log
     WHERE user_id = ?
     ORDER BY event_time, audit_id`
  ).all(userId);
  const eligibleAuditRows = filterRowsAtOrBefore(auditRows, 'event_time', parsedRequest.audit_at);

  for (const row of eligibleAuditRows) {
    if (row.field_name === 'email') {
      addEmail(identifiers.emails, row.old_value);
      addEmail(identifiers.emails, row.new_value);
    } else if (row.field_name === 'phone') {
      addUnique(identifiers.phones, row.old_value);
      addUnique(identifiers.phones, row.new_value);
    } else if (row.field_name === 'email_hash') {
      addEmailHash(identifiers.emailHashes, row.old_value);
      addEmailHash(identifiers.emailHashes, row.new_value);
    }
  }

  if (identity && identity.updated_at && Date.parse(identity.updated_at) <= Date.parse(parsedRequest.audit_at)) {
    addEmail(identifiers.emails, identity.email);
    addUnique(identifiers.phones, identity.phone);
    addEmailHash(identifiers.emailHashes, identity.email_hash);
    addUnique(identifiers.names, identity.name);
  }

  for (const historicalEmail of identifiers.emails) {
    addUnique(identifiers.emailHashes, emailHash(historicalEmail));
  }

  return { userId, identifiers, ambiguous };
}
