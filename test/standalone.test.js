import { describe, expect, it } from 'vitest';
import { classifyIntent } from '../src/pipeline/intent.js';
import { orderSteps } from '../src/pipeline/order.js';

describe('dataset-independent behavior', () => {
  it('classifies a synthetic explicit non-deletion request as not applicable', () => {
    expect(classifyIntent({
      request: {
        audit_at: '2026-01-01T00:00:00Z',
        request_text: 'This is not a deletion request.'
      }
    }).intent).toBe('NOT_APPLICABLE');
  });

  it('orders synthetic steps by phase and operation', () => {
    const ordered = orderSteps([
      {
        phase: 'VERIFICATION',
        operation: 'VERIFY_RECORD_ABSENT',
        system_id: 'account_service',
        resource_id: 'fixture_record'
      },
      {
        phase: 'FINDING',
        operation: 'REPORT_REMAINING_RECORD',
        system_id: 'account_service',
        resource_id: 'fixture_record'
      }
    ]);

    expect(ordered.map(({ phase }) => phase)).toEqual(['FINDING', 'VERIFICATION']);
  });
});
