import { z } from 'zod';
import { filterActivityAtOrBefore } from './time.js';

const requestSchema = z.object({
  email: z.string().optional(),
  audit_at: z.string().min(1),
  request_text: z.string().default('')
});

const deletionNegationPatterns = [
  /\b(?:not\s+asking|not\s+requesting|not\s+a\s+request)\s+(?:for\s+)?(?:any\s+)?(?:account\s+)?(?:deletion|erasure|removal|closing|closure)\b/iu,
  /\bnot\s+(?:a\s+)?(?:request|asking)\s+to\s+(?:delete|erase|remove|close)\b/iu,
  /\bthis\s+is\s+not\s+(?:a\s+)?(?:deletion|erasure|removal|closure)\s+request\b/iu,
  /\b(?:do\s+not|don't|dont|never)\s+(?:delete|erase|remove|wipe|close)\b/iu,
  /\b(?:leave|keep)\s+(?:(?:my|the|this)\s+)?(?:account|profile|history|records|data)\b(?:\s+[\p{L}\p{N}'’-]+){0,8}\s+(?:active|open|as\s+it\s+is|as\s+they\s+are|untouched|unchanged|in\s+place)\b/iu,
  /\bwithout\s+(?:removing|deleting|changing|altering)\b[\s\S]{0,80}\b(?:any\s+)?(?:of\s+)?(?:my\s+)?(?:records|data|information|account|profile|history)\b/iu,
  /\b(?:do\s+not|don't|dont|never)\s+(?:change|alter)\b[\s\S]{0,60}\b(?:my\s+)?(?:records|data|information|account|profile|history)\b/iu,
  /\b(?:continue|keep)\s+(?:using|to\s+use)\s+(?:the\s+)?(?:service|account)\b/iu,
  /\b(?:only|just)\b.{0,100}\b(?:still\s+want|keep|retain|need)\b.{0,40}\b(?:account|profile|receipts|service\s+messages|purchase\s+history)\b/iu,
  /\b(?:no\s+quiero|no\s+solicito|no\s+estoy\s+pidiendo)\b.{0,60}\b(?:eliminaci[oó]n|borrado|supresi[oó]n|cancelaci[oó]n)\b/iu,
  /\bno\s+(?:estoy\s+)?(?:pidiendo|solicitando)\s+(?:la\s+)?(?:eliminaci[oó]n|supresi[oó]n|borrado|cierre)\b/iu,
  /\bno\s+(?:solicito|pido)\s+(?:(?:la|el)\s+)?(?:eliminaci[oó]n|supresi[oó]n|borrado|cierre)\b/iu,
  /\b(?:esto\s+)?no\s+es\s+(?:una\s+)?(?:solicitud|petici[oó]n)\s+de\s+(?:eliminaci[oó]n|supresi[oó]n|borrado|cierre)\b/iu,
  /\bno\s+(?:quiero|solicito|pido)\b.{0,60}\b(?:borrar|eliminar|suprimir|cerrar)\b/iu,
  /\b(?:no\s+borres|no\s+borrar|no\s+elimines|no\s+eliminar|no\s+suprima|no\s+suprimir|no\s+cierres|no\s+cerrar)\b/iu,
  /\b(?:deja|mant[eé]n|conserva|mantener|conservar)\s+(?:la\s+)?(?:cuenta|perfil)\s+(?:activa|activo|abierta|abierto|como\s+est[aá]|sin\s+cambios)\b/iu,
  /\b(?:deja|mant[eé]n|conserva|mantener|conservar)\s+(?:mi\s+|el\s+|la\s+)?(?:cuenta|perfil|historial|registros|datos)\s+(?:en\s+su\s+lugar|como\s+est[aá]|sin\s+cambios|intact[oa]s?)\b/iu,
  /\bsin\s+(?:borrar|eliminar|suprimir|cambiar|modificar)\b[\s\S]{0,80}\b(?:ning[uú]n\s+)?(?:registro|registros|datos|informaci[oó]n|cuenta|perfil|historial)\b/iu,
  /\b(?:no\s+quiero|quiero\s+mantener|quiero\s+conservar)\s+(?:la\s+)?(?:cuenta|perfil)\b/iu,
  /\b(?:laissez|gardez|conservez)\s+(?:mon\s+)?(?:compte|profil|historique|dossiers|donn[ée]es)\b(?:\s+[\p{L}\p{N}'’-]+){0,8}\s+(?:actif|ouverte?|tel(?:le)?s?\s+quel(?:le)?s?|inchang[eé]s?|en\s+place|intact(?:e|s|es)?)\b/iu,
  /\bce(?:ci)?\s+n['’]est\s+pas\s+une\s+demande\s+de\s+(?:suppression|effacement|fermeture)\b/iu,
  /\bje\s+ne\s+(?:demande|souhaite|veux)\s+pas\b.{0,60}\b(?:suppression|effacement|fermeture)\b/iu,
  /\bce(?:ci)?\s+n['’]est\s+pas\s+(?:une\s+)?demande\s+de\s+(?:suppression|effacement|fermeture)\b/iu,
  /\bje\s+ne\s+(?:demande|souhaite|veux)\s+pas\b.{0,60}\b(?:la\s+)?(?:suppression|effacement|fermeture)\b/iu,
  /\bje\s+ne\s+(?:veux|souhaite|demande)\s+pas\b.{0,60}\b(?:supprimer|effacer|fermer)\b/iu,
  /\bne\s+(?:me\s+)?(?:supprimez|supprime|supprimer|effacez|efface|effacer|fermez|fermer)\s+pas\b/iu,
  /\b(?:laissez|laisser|gardez|garder|conservez|conserver)\s+(?:mon\s+)?(?:compte|profil)\s+(?:actif|ouvert|tel\s+quel|inchang[eé])\b/iu,
  /\b(?:garder|laissez|laisser|gardez|garder|conservez|conserver)\s+(?:(?:mon|ma|mes|le|la|les)\s+)?(?:profil|historique|dossiers|donn[ée]es)\s+(?:en\s+place|tel(?:le)?s?\s+quel(?:le)?s?|inchang[eé]s?)\b/iu,
  /\bsans\s+(?:supprimer|effacer|modifier|changer)\b[\s\S]{0,80}\b(?:mes\s+)?(?:dossiers|donn[ée]es|informations?|compte|profil|historique)\b/iu,
  /\b(?:je\s+veux\s+garder|je\s+souhaite\s+conserver)\s+(?:mon\s+)?(?:compte|profil)\b/iu,
  /(?:削除|消去|退会).{0,12}(?:したくありません|を希望しません|を希望していません|を求めていません|しないでください|しないで)/u,
  /(?:これは|これ|私の依頼は)?(?:削除|消去|退会)(?:の)?(?:依頼|要求|リクエスト)ではありません/u,
  /(?:削除|消去|退会)(?:を|は)?(?:依頼|希望|要求)していません/u,
  /(?:アカウント|プロフィール).{0,10}(?:有効なまま|開いたまま|そのまま|維持したい|残したい)/u,
  /(?:アカウント|プロフィール).{0,8}(?:削除|消去|退会).{0,8}(?:しないで|しません)/u,
  /(?:履歴|記録|データ|情報).{0,10}(?:そのまま|残したい|保持したい|変更しないで)/u,
  /(?:削除|消去|変更).{0,8}(?:せずに|しないで).{0,14}(?:記録|データ|情報|履歴)/u
];

const nonDeletionAskPatterns = [
  /\b(?:access|view|see|obtain|tell\s+me\s+what)\b.{0,60}\b(?:my\s+)?(?:data|information|records|account|profile)\b/iu,
  /\bwhat\s+(?:personal\s+)?(?:data|information|records)\b.{0,60}\b(?:hold|have|store)\b/iu,
  /\b(?:send|give|provide|download|export|request)\b.{0,80}\b(?:me\s+)?(?:a\s+)?(?:copy|export|download|data|information|records|invoices?|receipts?|statements?)\b/iu,
  /\b(?:copy|download|export|provide|send)\b.{0,60}\b(?:my\s+)?(?:invoices?|receipts?|statements?)\b(?:.{0,30}\bportable\s+format\b)?/iu,
  /\b(?:portable\s+format|machine[- ]readable\s+format)\b/iu,
  /\b(?:need|want|request)\b.{0,50}\b(?:a\s+)?copy\b/iu,
  /\b(?:copy|export|download)\b.{0,60}\b(?:my\s+)?(?:data|information|records|account|profile|invoices?)\b/iu,
  /\b(?:correct|correction|rectify|update|fix|replace|change|reset)\b.{0,60}\b(?:my\s+)?(?:data|information|records|details|account|profile|email|e-mail|phone|telephone|address|number|name|login|password)\b/iu,
  /\b(?:email|e-mail|phone|telephone|mobile|login|password)\b.{0,40}\b(?:change|update|replace|reset|correct)\b/iu,
  /\b(?:out\s+of\s+date|misspelled|incorrect|wrong)\b.{0,50}\b(?:profile|account|number|name|email|phone|address)\b/iu,
  /\b(?:opt[\s-]?out|unsubscribe|unsubscribing|remove\s+me\s+from|stop|cease)\b.{0,80}\b(?:sending|marketing|promotional|newsletter|emails?|mailing|list|messages?)?\b/iu,
  /\b(?:marketing|promotional|newsletter)\s+(?:emails?|messages?|updates?)\b/iu,
  /\b(?:login|log\s+in|sign\s+in|password)\b.{0,60}\b(?:help|issue|problem|assistance|reset|access)\b/iu,
  /\b(?:help|assistance)\b.{0,60}\b(?:login|log\s+in|sign\s+in|password)\b/iu,
  /\b(?:quiero|solicito|pido|necesito)\b.{0,60}\b(?:acceder|acceso|exportar|copia|corregir|rectificar|actualizar|cambiar|reemplazar)\b/iu,
  /\b(?:acceso|copia|exportaci[oó]n|correcci[oó]n|rectificaci[oó]n|actualizaci[oó]n|cambio)\b.{0,60}\b(?:datos|informaci[oó]n|cuenta|perfil|correo|direcci[oó]n|n[uú]mero)\b/iu,
  /\b(?:darme\s+de\s+baja|cancelar\s+la\s+suscripci[oó]n|dejar\s+de\s+recibir|ayuda\s+para\s+iniciar\s+sesi[oó]n|restablec(?:er|e)\s+mi\s+contrase[nñ]a)\b/iu,
  /\b(?:detener|det[eé]n|dejar|deja|cancelar)\b.{0,60}\b(?:(?:de\s+)?recibir|enviar|los?\s+correos?\s+)?\b(?:correos?\s+)?(?:promocionales?|de\s+marketing|bolet[ií]n(?:es)?(?:\s+informativos?)?|newsletter)\b/iu,
  /\b(?:cambi(?:ar|a|o|e)|actualiz(?:ar|a|o|e)|modific(?:ar|a|o|e)|reemplaz(?:ar|a|o|e))\s+(?:mi\s+)?(?:tel[eé]fono|n[uú]mero|correo|e-?mail)\b/iu,
  /\b(?:copias?|descarg(?:ar|a|ue)|export(?:ar|a|e)|formato\s+portable)\b.{0,60}\b(?:facturas?|recibos?|extractos?|estados?\s+de\s+cuenta|datos)\b/iu,
  /\b(?:acc[eè]s|acc[eé]der|consulter|copie|exporter|t[eé]l[eé]charger|corriger|rectifier|mettre\s+à\s+jour|modifier|changer)\b.{0,60}\b(?:mes\s+)?(?:donn[ée]es|informations?|compte|profil|adresse|courriel|e-mail|num[eé]ro|t[eé]l[eé]phone)\b/iu,
  /\b(?:d[ée]sinscri(?:re|vez-vous)|me\s+d[ée]sabonner|d[ée]sabonnez?-moi|ne\s+plus\s+recevoir|aide\s+pour\s+me\s+connecter|r[eé]initialis(?:er|ez)\s+mon\s+mot\s+de\s+passe)\b/iu,
  /\b(?:arr[eê]ter|cesser)\s+(?:les\s+)?(?:e-mails?|courriels?|messages?)\s+(?:promotionnels?|marketing|de\s+la\s+lettre\s+d['’]information)\b/iu,
  /\b(?:chang(?:er|ez)|modifi(?:er|ez)|mett(?:re|ez)\s+à\s+jour|remplac(?:er|ez))\s+(?:mon\s+)?(?:t[eé]l[eé]phone|num[eé]ro|courriel|e-mail|adresse\s+e-mail)\b/iu,
  /\b(?:copie|t[eé]l[eé]charg(?:er|ez)|export(?:er|ez)|format\s+portable)\b.{0,60}\b(?:factures?|re[cç]us?|relev[eé]s?|donn[ée]es)\b/iu,
  /\b(?:arr[eê]ter|se\s+d[ée]sabonner|d[ée]sabonnez?-moi|ne\s+plus\s+recevoir)\b.{0,60}\b(?:newsletter|lettre\s+d['’]information|courriels?\s+promotionnels?|e-mails?\s+marketing)\b/iu,
  /(?:開示|アクセス|閲覧|コピー|エクスポート|訂正|修正|変更|配信.{0,3}停止|オプトアウト|登録解除|ログイン.{0,6}(?:できない|手伝)|パスワード.{0,8}(?:リセット|再設定)|電話番号.{0,6}(?:変更|更新|交換)|メールアドレス.{0,6}(?:変更|更新|交換)|(?:請求書|領収書|明細書).{0,10}(?:コピー|写し|ポータブル形式))/u
];

const deletionAskPatterns = [
  /\b(?:delete|erase|remove|wipe|close|terminate)\b.{0,70}\b(?:my\s+)?(?:account|profile|data|personal\s+information|export\s+file|search\s+result)\b/iu,
  /\b(?:delete|erase|remove|wipe|close|terminate)\s+(?:it|everything|all(?:\s+of)?\s+(?:my\s+)?(?:data|records|information))\b/iu,
  /\b(?:everything|all(?:\s+of)?\s+(?:my\s+)?(?:data|records|information))\s+(?:should\s+be\s+)?(?:deleted|erased|removed)\b/iu,
  /\b(?:deletion|erasure|removal)\b.{0,70}\b(?:of\s+)?(?:my\s+)?(?:account|profile|data|personal\s+information)\b/iu,
  /\b(?:quiero|solicito|pido|por favor)\b.{0,70}\b(?:eliminar|borrar|suprimir|cerrar)\b/iu,
  /\b(?:eliminaci[oó]n|borrado|supresi[oó]n)\b.{0,60}\b(?:de\s+)?(?:mi\s+)?(?:cuenta|perfil|datos|informaci[oó]n)\b/iu,
  /\b(?:je\s+veux|je\s+demande|veuillez|merci\s+de)\b.{0,70}\b(?:supprimer|effacer|fermer)\b/iu,
  /\b(?:suppression|effacement|fermeture)\b.{0,60}\b(?:de\s+)?(?:mon\s+)?(?:compte|profil|donn[ée]es|informations?)\b/iu,
  /(?:アカウント|個人情報|データ).{0,16}(?:削除|消去|退会)/u,
  /(?:削除|消去|退会).{0,16}(?:アカウント|個人情報|データ)/u
];

function matchesAny(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasExactIdentifier(text, identifier) {
  if (typeof text !== 'string' || typeof identifier !== 'string' || identifier.length === 0) {
    return false;
  }
  const escaped = escapeRegExp(identifier);
  const boundary = identifier.includes('@')
    ? '[A-Za-z0-9._%+-]'
    : '[\\p{L}\\p{N}_]';
  return new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`, 'iu').test(text);
}

function resourceReferencesInText(text, knownResourceIds) {
  return knownResourceIds.filter((resourceId) => hasExactIdentifier(text, resourceId));
}

export function findLinkedResourceIds(_database, _identity, _auditAt, suppliedResourceIds = []) {
  return new Set(suppliedResourceIds.filter((value) => (
    typeof value === 'string' && value.length > 0
  )));
}

function hasNonDeletionClassification(database, identity, request, suppliedResourceIds) {
  if (!database) {
    return false;
  }
  const linkedResources = findLinkedResourceIds(
    database,
    identity,
    request.audit_at,
    suppliedResourceIds
  );
  if (linkedResources.size === 0) {
    return false;
  }

  const rows = filterActivityAtOrBefore(database.prepare(
    `SELECT event_time, resource_id, details
     FROM system_activity
     WHERE event_type = 'CLASSIFY_REQUEST'`
  ).all(), request.audit_at);
  return rows.some((row) => (
    (linkedResources.has(row.resource_id) ||
      resourceReferencesInText(row.details, [...linkedResources]).length > 0) &&
    /\bclassified\b[\s\S]{0,160}\bnon[- ]deletion\b/iu.test(row.details ?? '')
  ));
}

function removeNegatedDeletionClauses(text) {
  return text
    .replace(
      /\b(?:do not|don't|dont|never)\s+(?:delete|erase|remove|wipe|close)(?:\s+(?:or|and)\s+(?:delete|erase|remove|wipe|close))*\b(?:\s+(?:my|the|this))?(?:\s+(?:account|profile|data|personal\s+information))?/giu,
      ' '
    )
    .replace(
      /\b(?:not\s+asking|not\s+requesting|not\s+a\s+request)\s+(?:for\s+)?(?:any\s+)?(?:account\s+)?(?:deletion|erasure|removal|closing|closure)\b/giu,
      ' '
    )
    .replace(
      /\bnot\s+(?:a\s+)?(?:request|asking)\s+to\s+(?:delete|erase|remove|wipe|close)\b(?:\s+(?:my|the|this|it|anything))?(?:\s+(?:account|profile|data|personal\s+information))?/giu,
      ' '
    )
    .replace(
      /\bthis\s+is\s+not\s+(?:a\s+)?(?:deletion|erasure|removal|closure)\s+request\b/giu,
      ' '
    )
    .replace(
      /\bno\s+(?:solicito|quiero|pido)\b.{0,60}\b(?:borrar|eliminar|suprimir|cerrar)\b(?:\s+(?:la|mi|el))?(?:\s+(?:cuenta|perfil|datos|informaci[oó]n))?/giu,
      ' '
    )
    .replace(
      /\bno\s+(?:solicito|pido)\s+(?:(?:la|el)\s+)?(?:eliminaci[oó]n|supresi[oó]n|borrado|cierre)\b/giu,
      ' '
    )
    .replace(
      /\b(?:esto\s+)?no\s+es\s+(?:una\s+)?(?:solicitud|petici[oó]n)\s+de\s+(?:eliminaci[oó]n|supresi[oó]n|borrado|cierre)\b/giu,
      ' '
    )
    .replace(
      /\bje\s+ne\s+(?:veux|souhaite|demande)\s+pas\b.{0,60}\b(?:supprimer|effacer|fermer)\b(?:\s+(?:mon|ma|mes|le|la|les))?(?:\s+(?:compte|profil|donn[ée]es|informations?))?/giu,
      ' '
    )
    .replace(
      /\bje\s+ne\s+(?:demande|souhaite|veux)\s+pas\b[\s\S]{0,60}\b(?:suppression|effacement|fermeture)\b/giu,
      ' '
    )
    .replace(
      /\bne\s+(?:me\s+)?(?:supprimez|supprime|supprimer|effacez|efface|effacer|fermez|fermer)\s+pas\b(?:\s+(?:mon|ma|mes|le|la|les))?(?:\s+(?:compte|profil|donn[ée]es|informations?))?/giu,
      ' '
    )
    .replace(
      /\bce(?:ci)?\s+n['’]est\s+pas\s+(?:une\s+)?demande\s+de\s+(?:suppression|effacement|fermeture)\b/giu,
      ' '
    )
    .replace(
      /(?:アカウント|プロフィール|個人情報|データ).{0,8}(?:削除|消去|退会).{0,8}(?:したくありません|を希望しません|しないでください|しないで|しません)/gu,
      ' '
    )
    .replace(
      /(?:これは|これ|私の依頼は)?(?:削除|消去|退会)(?:の)?(?:依頼|要求|リクエスト)ではありません/gu,
      ' '
    )
    .replace(
      /(?:削除|消去|退会)(?:を|は)?(?:依頼|希望|要求)していません/gu,
      ' '
    );
}

/**
 * Reserved for conflicting negation and deletion signals. It is intentionally unused for now.
 */
export async function resolveAmbiguousIntentWithModel(_request) {
  throw new Error('Model-backed intent resolution is intentionally unused');
}

export function classifyIntent({ database, request, identity, resourceIds = [] }) {
  const parsedRequest = requestSchema.parse(request);
  const text = parsedRequest.request_text.trim();
  const explicitNonDeletion = matchesAny(deletionNegationPatterns, text);
  const hasNonDeletionAsk = matchesAny(nonDeletionAskPatterns, text);
  const activityNonDeletion = hasNonDeletionClassification(
    database,
    identity,
    parsedRequest,
    resourceIds
  );
  const hasDeletionAsk = matchesAny(deletionAskPatterns, removeNegatedDeletionClauses(text));

  if (activityNonDeletion || (explicitNonDeletion && !hasDeletionAsk)) {
    const signals = [];
    if (activityNonDeletion) signals.push('1a');
    if (explicitNonDeletion) signals.push('1b');
    return {
      intent: 'NOT_APPLICABLE',
      ambiguous: false,
      reason: signals.length === 2
        ? 'explicit_and_activity_non_deletion'
        : activityNonDeletion ? 'activity_classification'
          : hasNonDeletionAsk ? 'explicit_non_deletion_with_ask' : 'explicit_non_deletion',
      signals
    };
  }

  return {
    intent: 'DELETION',
    ambiguous: false,
    reason: explicitNonDeletion || activityNonDeletion
      ? 'mixed_signals_model_hook_unused'
      : 'deletion_default',
    signals: [
      ...(activityNonDeletion ? ['1a'] : []),
      ...(explicitNonDeletion ? ['1b'] : [])
    ]
  };
}
