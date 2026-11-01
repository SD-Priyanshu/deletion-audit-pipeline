import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveIdentity } from '../src/pipeline/identity.js';
import { classifyIntent } from '../src/pipeline/intent.js';
import { resolveFootprint } from '../src/pipeline/footprint.js';
import { filterActivityAtOrBefore, filterEvidenceAtOrBefore } from '../src/pipeline/time.js';
import { databasePath } from '../src/config.js';
import { datasetErrorMessage, isDatasetAvailable } from '../src/dataset.js';
import { existsSync } from 'node:fs';

const datasetReady = isDatasetAvailable() && existsSync(databasePath);
const datasetSkipReason = isDatasetAvailable()
  ? 'Run npm run ingest before dataset-backed tests.'
  : datasetErrorMessage();

function openIngestedDatabase() {
  return new DatabaseSync(databasePath, { readOnly: true });
}

function hashEmail(email) {
  return createHash('sha256')
    .update(email.trim().toLowerCase(), 'utf8')
    .digest('hex');
}

function findChangedEmailFixture(database) {
  const changedUsers = database.prepare(
    `SELECT DISTINCT user_id
     FROM user_audit_log
     WHERE field_name = 'email'
       AND old_value IS NOT NULL
       AND new_value IS NOT NULL
       AND lower(trim(old_value)) != lower(trim(new_value))
     ORDER BY user_id`
  ).all();

  for (const { user_id: userId } of changedUsers) {
    const changes = database.prepare(
      `SELECT event_time, old_value, new_value
       FROM user_audit_log
       WHERE user_id = ? AND field_name = 'email'
       ORDER BY event_time, audit_id`
    ).all(userId);
    const current = database.prepare(
      'SELECT email FROM user_identities WHERE user_id = ?'
    ).get(userId);
    const latestChange = changes.at(-1);
    if (
      changes.length > 0 &&
      current &&
      latestChange &&
      latestChange.new_value?.trim().toLowerCase() === current.email?.trim().toLowerCase()
    ) {
      return {
        userId,
        requestEmail: changes[0].old_value,
        currentEmail: current.email,
        auditAt: latestChange.event_time
      };
    }
  }
  throw new Error('The ingested dataset does not contain a replayable email change');
}

function createSimilarEmailFixture(database) {
  const users = database.prepare(
    'SELECT user_id, name, email, phone, email_hash, updated_at FROM user_identities ORDER BY user_id LIMIT 2'
  ).all();
  if (users.length < 2 || !users[0].email || !users[1].email) {
    throw new Error('The ingested dataset does not contain two users for an exact-match test');
  }

  const [target, other] = users;
  const [localPart, domain] = target.email.split('@');
  if (!localPart || !domain) {
    throw new Error('The selected ingested identity does not contain an email address');
  }
  const similarEmail = `${localPart}x@${domain}`;

  const fixture = new DatabaseSync(':memory:');
  fixture.exec(`
    CREATE TABLE user_identities (
      user_id TEXT, name TEXT, email TEXT, phone TEXT, email_hash TEXT, updated_at TEXT
    );
    CREATE TABLE user_audit_log (
      audit_id TEXT, user_id TEXT, event_time TEXT, field_name TEXT, old_value TEXT, new_value TEXT
    );
    CREATE TABLE system_activity (
      activity_id TEXT, event_time TEXT, event_type TEXT, source_system TEXT,
      target_system TEXT, resource_id TEXT, reported_result TEXT, details TEXT
    );
  `);
  const insert = fixture.prepare(
    `INSERT INTO user_identities (user_id, name, email, phone, email_hash, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insert.run(target.user_id, target.name, target.email, target.phone, target.email_hash, target.updated_at);
  insert.run(other.user_id, other.name, similarEmail, other.phone, other.email_hash, other.updated_at);
  return { fixture, targetId: target.user_id, otherId: other.user_id, similarEmail };
}

describe.skipIf(!datasetReady)(datasetSkipReason, () => {
describe('identity resolution', () => {
  it('replays email changes when the request uses the historical address', () => {
    const database = openIngestedDatabase();
    try {
      const fixture = findChangedEmailFixture(database);
      const identity = resolveIdentity(database, {
        email: fixture.requestEmail,
        audit_at: fixture.auditAt
      });

      expect(identity.userId).toBe(fixture.userId);
      expect(identity.ambiguous).toBe(false);
      expect(identity.identifiers.emails).toContain(fixture.requestEmail.trim().toLowerCase());
      expect(identity.identifiers.emails).toContain(fixture.currentEmail.trim().toLowerCase());
      expect(identity.identifiers.emailHashes).toContain(hashEmail(fixture.requestEmail));
      expect(identity.identifiers.emailHashes).toContain(hashEmail(fixture.currentEmail));
    } finally {
      database.close();
    }
  });

  it('matches a similar address to its exact owner, not the neighboring user', () => {
    const sourceDatabase = openIngestedDatabase();
    const { fixture, targetId, otherId, similarEmail } = createSimilarEmailFixture(sourceDatabase);
    try {
      const identity = resolveIdentity(fixture, {
        email: similarEmail,
        audit_at: '9999-12-31T23:59:59.999Z'
      });

      expect(identity.userId).toBe(otherId);
      expect(identity.userId).not.toBe(targetId);
      expect(identity.ambiguous).toBe(false);
    } finally {
      fixture.close();
      sourceDatabase.close();
    }
  });
});

describe('request intent', () => {
  it('keeps every public sample request in the deletion class', () => {
    const database = openIngestedDatabase();
    try {
      const requests = database.prepare(
        'SELECT case_id, email, audit_at, request_text FROM sample_deletion_requests ORDER BY case_id'
      ).all();
      expect(requests).toHaveLength(32);
      for (const request of requests) {
        const identity = resolveIdentity(database, request);
        const footprint = resolveFootprint(database, request);
        const result = classifyIntent({
          database,
          request,
          identity,
          resourceIds: footprint.resources.map(({ resource_id: resourceId }) => resourceId)
        });
        expect(result.intent, request.case_id).toBe('DELETION');
      }
    } finally {
      database.close();
    }
  });

  it('classifies all 32 sample requests as deletion cases', () => {
    const database = openIngestedDatabase();
    try {
      const requests = database.prepare(
        'SELECT case_id, email, audit_at, request_text FROM sample_deletion_requests'
      ).all();
      expect(requests).toHaveLength(32);
      for (const request of requests) {
        expect(classifyIntent({
          database,
          request,
          identity: resolveIdentity(database, request)
        }).intent).toBe('DELETION');
      }
    } finally {
      database.close();
    }
  });

  it('classifies a request to delete an export file as deletion', () => {
    const database = openIngestedDatabase();
    try {
      const request = database.prepare(
        "SELECT case_id, email, audit_at, request_text FROM sample_deletion_requests WHERE case_id = 'case_08'"
      ).get();
      expect(classifyIntent({
        database,
        request,
        identity: resolveIdentity(database, request)
      }).intent).toBe('DELETION');
    } finally {
      database.close();
    }
  });

  it.each([
    ['English deletion', 'Please permanently erase my account and its profile.', 'DELETION'],
    ['English not deletion - keep open', 'Keep the account open and send me a copy of its records.', 'NOT_APPLICABLE'],
    ['English not deletion - no erasure request', 'I am not asking for erasure; please download my stored information.', 'NOT_APPLICABLE'],
    ['English not deletion - not a request to erase', 'This is an information inquiry, not a request to erase anything.', 'NOT_APPLICABLE'],
    ['English not deletion - preserve records', 'Please update my phone without changing any records.', 'NOT_APPLICABLE'],
    ['Spanish deletion', 'Solicito eliminar mi cuenta de forma permanente.', 'DELETION'],
    ['Spanish not deletion - keep active', 'Mantén la cuenta activa y envíame una copia de los datos.', 'NOT_APPLICABLE'],
    ['Spanish not deletion - no removal request', 'No estoy pidiendo la eliminación; necesito actualizar mi número.', 'NOT_APPLICABLE'],
    ['Spanish not deletion - preserve records', 'Solicito cambiar mi correo sin modificar ningún registro.', 'NOT_APPLICABLE'],
    ['French deletion', 'Je demande la suppression de mon compte.', 'DELETION'],
    ['French not deletion - keep open', 'Gardez mon compte ouvert; copie mes données, s’il vous plaît.', 'NOT_APPLICABLE'],
    ['French not deletion - no closure request', 'Je ne demande pas la suppression; merci de corriger mon numéro.', 'NOT_APPLICABLE'],
    ['French not deletion - preserve records', 'Sans modifier mes dossiers, veuillez changer mon adresse e-mail.', 'NOT_APPLICABLE'],
    ['Japanese deletion', 'アカウントを完全に削除してください。', 'DELETION'],
    ['Japanese not deletion - keep active', 'アカウントを有効なままにして、情報をコピーしてください。', 'NOT_APPLICABLE'],
    ['Japanese not deletion - no deletion request', '削除を希望していません。メールアドレスを変更してください。', 'NOT_APPLICABLE'],
    ['Japanese not deletion - preserve history', '履歴をそのままにして、データを開示してください。', 'NOT_APPLICABLE']
  ])('classifies synthetic %s phrase', (_label, requestText, expectedIntent) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    })).toMatchObject({ intent: expectedIntent, ambiguous: false });
  });

  it.each([
    'Please delete this export file.',
    'I am not sure my data was removed; please delete it.',
    'Please delete my account and keep a copy of my data.',
    'I no longer need my account; please delete it.',
    'Please delete my account and leave a copy of the report for me.',
    'Download the export before deleting my account.'
  ])('keeps a deletion request as DELETION despite incidental terms: %s', (requestText) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    })).toMatchObject({ intent: 'DELETION', ambiguous: false });
  });

  it.each([
    ['English explicit negation alone', 'This is not a deletion request.'],
    ['English negated action alone', 'Do not delete my account.'],
    ['Spanish explicit negation alone', 'Esto no es una solicitud de eliminación de mi cuenta.'],
    ['Spanish negated action alone', 'No elimines mi cuenta.'],
    ['French explicit negation alone', 'Je ne demande pas la suppression de mon compte.'],
    ['French negated action alone', 'Ne fermez pas mon compte.'],
    ['Japanese explicit negation alone', 'これはアカウント削除の依頼ではありません。'],
    ['Japanese negated action alone', 'アカウントを削除しないでください。'],
    ['English coordinated negation', 'Do not delete or close my account.']
  ])('accepts synthetic %s without an additional ask', (_label, requestText) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    })).toMatchObject({ intent: 'NOT_APPLICABLE', ambiguous: false });
  });

  it.each([
    ['English', 'I am not asking for erasure; please reset my password.'],
    ['Spanish', 'No solicito el cierre; por favor actualiza mi teléfono.'],
    ['French', 'Je ne demande pas la suppression; veuillez arrêter les courriels promotionnels.'],
    ['Japanese', '削除を希望していません。請求書のコピーをポータブル形式でください。']
  ])('recognizes synthetic %s non-deletion request vocabulary', (_language, requestText) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    })).toMatchObject({
      intent: 'NOT_APPLICABLE',
      reason: 'explicit_non_deletion_with_ask',
      ambiguous: false
    });
  });

  it.each([
    ['English newsletter opt-out', 'This is not a deletion request; opt out of marketing emails.'],
    ['English phone update', 'I am not asking for account erasure; replace my phone number.'],
    ['English login reset', 'Do not delete my account; help me reset the login password.'],
    ['English portable statement copy', 'I am not requesting deletion; send my statements in a portable format.'],
    ['Spanish newsletter opt-out', 'No solicito la eliminación; deja de recibir boletines promocionales.'],
    ['Spanish email update', 'No pido el cierre; actualiza mi correo electrónico.'],
    ['Spanish password reset', 'No solicito el borrado; restablece mi contraseña.'],
    ['Spanish portable receipt copy', 'No estoy pidiendo eliminación; descarga copias de mis recibos en formato portátil.'],
    ['French newsletter opt-out', 'Ceci n’est pas une demande de suppression; désabonnez-moi des newsletters.'],
    ['French phone update', 'Je ne demande pas la suppression; changez mon téléphone.'],
    ['French password reset', 'Je ne demande pas la fermeture; réinitialisez mon mot de passe.'],
    ['French portable invoice copy', 'Je ne demande pas la suppression; téléchargez les factures en format portable.'],
    ['Japanese newsletter opt-out', '削除の依頼ではありません。ニュースレターの配信を停止してください。'],
    ['Japanese phone update', '削除を希望していません。電話番号を更新してください。'],
    ['Japanese password reset', '削除の依頼ではありません。パスワードを再設定してください。'],
    ['Japanese portable invoice copy', '削除を希望していません。請求書の写しをポータブル形式でください。']
  ])('recognizes synthetic non-deletion ask: %s', (_label, requestText) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    })).toMatchObject({
      intent: 'NOT_APPLICABLE',
      reason: 'explicit_non_deletion_with_ask',
      ambiguous: false
    });
  });

  it.each([
    ['English intervening words', 'Please keep my account and all its records as they are; send me a copy.'],
    ['English profile and history', 'Leave my profile and order history in place; I need access.'],
    ['French intervening words', 'Gardez mon compte et tous mes dossiers en place; je souhaite accéder à mes données.']
  ])('matches synthetic preservation wording with %s', (_label, requestText) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    }).intent).toBe('NOT_APPLICABLE');
  });

  it.each([
    'Please delete my account and keep a copy of my invoices.',
    'I am not sure my data was removed, please delete it.',
    'Leave nothing behind, I want everything erased.',
    'I no longer need the account, delete it.',
    'I am not asking for deletion; please erase my data.',
    'Do not close my account, but erase my stored profile.'
  ])('keeps mixed text as DELETION when it contains an unnegated deletion ask: %s', (requestText) => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: requestText }
    })).toMatchObject({ intent: 'DELETION', ambiguous: false });
  });

  it('recognizes deletion intent in French and Japanese', () => {
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: 'Veuillez supprimer mon compte.' }
    }).intent).toBe('DELETION');
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: 'Je demande la suppression de mon compte.' }
    }).intent).toBe('DELETION');
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: 'Solicito la eliminación de mi cuenta.' }
    }).intent).toBe('DELETION');
    expect(classifyIntent({
      request: { audit_at: '2026-01-01T00:00:00Z', request_text: 'アカウントを削除してください。' }
    }).intent).toBe('DELETION');
  });

  it('uses a linked non-deletion activity event only at or before the cutoff', () => {
    const database = openIngestedDatabase();
    try {
      const activity = database.prepare(
        `SELECT resource_id, event_time
         FROM system_activity
         WHERE event_type = 'CLASSIFY_REQUEST'
         ORDER BY event_time
         LIMIT 1`
      ).get();
      const result = classifyIntent({
        database,
        request: {
          audit_at: activity.event_time,
          request_text: 'Please tell me what information you hold about my profile.'
        },
        resourceIds: [activity.resource_id]
      });
      expect(result).toMatchObject({ intent: 'NOT_APPLICABLE', reason: 'activity_classification' });

      const activityOverridesDeletionText = classifyIntent({
        database,
        request: {
          audit_at: activity.event_time,
          request_text: 'Please delete this account immediately.'
        },
        resourceIds: [activity.resource_id]
      });
      expect(activityOverridesDeletionText.intent).toBe('NOT_APPLICABLE');
      expect(activityOverridesDeletionText.signals).toContain('1a');

      const beforeEvent = classifyIntent({
        database,
        request: {
          audit_at: new Date(Date.parse(activity.event_time) - 1).toISOString(),
          request_text: 'Please tell me what information you hold about my profile.'
        },
        resourceIds: [activity.resource_id]
      });
      expect(beforeEvent.intent).toBe('DELETION');
    } finally {
      database.close();
    }
  });
});
});

describe('audit cutoff helpers', () => {
  it('includes rows exactly on the audit_at boundary and excludes later rows', () => {
    const cutoff = '2026-05-01T12:00:00.000Z';
    const activity = filterActivityAtOrBefore([
      { event_time: '2026-05-01T12:00:00.000Z' },
      { event_time: '2026-05-01T12:00:00.001Z' }
    ], cutoff);
    const evidence = filterEvidenceAtOrBefore([
      { captured_at: '2026-05-01T12:00:00.000Z' },
      { captured_at: '2026-05-01T12:00:00.001Z' }
    ], cutoff);

    expect(activity).toHaveLength(1);
    expect(evidence).toHaveLength(1);
  });
});
