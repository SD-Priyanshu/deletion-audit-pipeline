function timestampValue(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty timestamp string`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${label} is not a valid timestamp`);
  }
  return timestamp;
}

export function isAtOrBefore(timestamp, auditAt) {
  return timestampValue(timestamp, 'timestamp') <= timestampValue(auditAt, 'auditAt');
}

export function filterRowsAtOrBefore(rows, timestampField, auditAt) {
  if (!Array.isArray(rows)) {
    throw new TypeError('rows must be an array');
  }
  if (typeof timestampField !== 'string' || timestampField.length === 0) {
    throw new TypeError('timestampField must be a non-empty string');
  }

  const cutoff = timestampValue(auditAt, 'auditAt');
  return rows.filter((row) => timestampValue(row?.[timestampField], timestampField) <= cutoff);
}

export function filterActivityAtOrBefore(rows, auditAt) {
  return filterRowsAtOrBefore(rows, 'event_time', auditAt);
}

export function filterEvidenceAtOrBefore(rows, auditAt) {
  return filterRowsAtOrBefore(rows, 'captured_at', auditAt);
}
