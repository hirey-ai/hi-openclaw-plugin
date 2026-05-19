import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildOpenClawHookPayloadWithRoute } from './openclaw-hooks-payload.js';

// Smoke tests for the 2026-05 pairing-viewer hint preprocessing. Walter's 5/18 bug:
// bot LLM read self listing's owner profile as "对方". Platform now ships
// viewer_relation_role per need_ref; we inject a hint + viewer_helper into the
// message LLM sees so it doesn't fall back to the old relation_role heuristic.

function makeBaseEvent(overrides: Partial<any> = {}): any {
  return {
    event_id: 'evt_test_1',
    topic: 'pairing.created',
    resource_ref: { resource_type: 'pairing', resource_id: 'pair_test' },
    payload: {
      pairing: { id: 'pair_test', left_agent_id: 'ag_a', right_agent_id: 'ag_b' },
      need_refs: [],
    },
    ...overrides,
  };
}

test('pairing.created with viewer_relation_role injects hint line and viewer_helper block', () => {
  const event = makeBaseEvent({
    payload: {
      pairing: { id: 'pair_test', left_agent_id: 'ag_dongxu', right_agent_id: 'ag_walter' },
      need_refs: [
        {
          listing_id: 'listing_dongxu',
          relation_role: 'source_published_need',
          agent_id: 'ag_dongxu',
          viewer_relation_role: 'counterparty',
        },
        {
          listing_id: 'listing_walter',
          relation_role: 'matched_need',
          agent_id: 'ag_walter',
          viewer_relation_role: 'self',
        },
      ],
    },
  });
  const out = buildOpenClawHookPayloadWithRoute({ event });
  assert.match(out.message, /\[hi pairing hint\]/);
  assert.match(out.message, /viewer_relation_role === "counterparty"/);
  const parsed = JSON.parse(out.message.split('\n\n').at(-1)!);
  assert.equal(parsed.viewer_helper.counterpart_listing_id, 'listing_dongxu');
  assert.equal(parsed.viewer_helper.self_listing_id, 'listing_walter');
  assert.equal(parsed.viewer_helper.counterpart_agent_id, 'ag_dongxu');
  assert.equal(parsed.viewer_helper.self_agent_id, 'ag_walter');
});

test('non-pairing event leaves message untouched (no hint, no viewer_helper)', () => {
  const event = makeBaseEvent({
    topic: 'agent.message.created',
    payload: { text: 'hello' },
  });
  const out = buildOpenClawHookPayloadWithRoute({ event });
  assert.doesNotMatch(out.message, /\[hi pairing hint\]/);
  const parsed = JSON.parse(out.message.split('\n\n').at(-1)!);
  assert.equal(parsed.viewer_helper, undefined);
});

test('pairing event with all unknown viewer_relation_role skips hint (avoid noise when platform can\'t derive viewer)', () => {
  const event = makeBaseEvent({
    payload: {
      pairing: { id: 'pair_test', left_agent_id: 'ag_a', right_agent_id: 'ag_b' },
      need_refs: [
        {
          listing_id: 'listing_a',
          relation_role: 'source_published_need',
          agent_id: null,
          viewer_relation_role: 'unknown',
        },
        {
          listing_id: 'listing_b',
          relation_role: 'matched_need',
          agent_id: null,
          viewer_relation_role: 'unknown',
        },
      ],
    },
  });
  const out = buildOpenClawHookPayloadWithRoute({ event });
  assert.doesNotMatch(out.message, /\[hi pairing hint\]/);
  const parsed = JSON.parse(out.message.split('\n\n').at(-1)!);
  assert.equal(parsed.viewer_helper, undefined);
});
