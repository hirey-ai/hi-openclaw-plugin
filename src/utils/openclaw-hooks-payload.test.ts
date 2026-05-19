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

// 2026-05 P3：listing-less pair（owner_contact / company_contact）携带 viewer_side +
// counterpart_snapshot + origin。这些字段是接收方 bot 渲染对方的首选信息源。
test('listing-less pair (owner_contact) surfaces counterpart_snapshot + viewer_side + origin', () => {
  const event = makeBaseEvent({
    payload: {
      pairing: {
        id: 'pair_owner_test',
        left_agent_id: 'ag_walter',
        right_agent_id: 'ag_dongxu',
        origin: { kind: 'owner_contact', id: 'agit_9befe4cbb14a' },
      },
      need_refs: [], // listing-less → 0 refs
      viewer_side: 'left',
      origin: { kind: 'owner_contact', id: 'agit_9befe4cbb14a' },
      counterpart_snapshot: {
        agent: { agent_id: 'ag_dongxu', display_name: 'OpenClaw Hi Agent', public_id: 135 },
        owner: { customer_id: 'agit_1dd72c32d50a', display_name: 'dongxu', headline: null },
        company: null,
      },
    },
  });
  const out = buildOpenClawHookPayloadWithRoute({ event });
  assert.match(out.message, /\[hi pairing hint\]/);
  assert.match(out.message, /counterpart_snapshot/);
  assert.match(out.message, /owner_contact/);
  const parsed = JSON.parse(out.message.split('\n\n').at(-1)!);
  assert.equal(parsed.viewer_helper.viewer_side, 'left');
  assert.equal(parsed.viewer_helper.counterpart_agent_id, 'ag_dongxu');
  assert.equal(parsed.viewer_helper.self_agent_id, 'ag_walter');
  assert.equal(parsed.viewer_helper.origin_kind, 'owner_contact');
  assert.equal(parsed.viewer_helper.counterpart_snapshot.owner.customer_id, 'agit_1dd72c32d50a');
});

test('listing-less pair (company_contact) carries company snapshot', () => {
  const event = makeBaseEvent({
    payload: {
      pairing: {
        id: 'pair_company_test',
        left_agent_id: 'ag_caller',
        right_agent_id: 'ag_walter',
        origin: { kind: 'company_contact', id: 'co_GuFU0auZwBIq' },
      },
      need_refs: [],
      viewer_side: 'right',
      origin: { kind: 'company_contact', id: 'co_GuFU0auZwBIq' },
      counterpart_snapshot: {
        agent: { agent_id: 'ag_caller', display_name: 'caller bot', public_id: 99 },
        owner: { customer_id: 'cus_caller', display_name: 'caller', headline: 'AI explorer' },
        company: null,
      },
    },
  });
  const out = buildOpenClawHookPayloadWithRoute({ event });
  assert.match(out.message, /company_contact/);
  const parsed = JSON.parse(out.message.split('\n\n').at(-1)!);
  assert.equal(parsed.viewer_helper.viewer_side, 'right');
  assert.equal(parsed.viewer_helper.counterpart_agent_id, 'ag_caller');
  assert.equal(parsed.viewer_helper.origin_kind, 'company_contact');
  assert.equal(parsed.viewer_helper.origin_id, 'co_GuFU0auZwBIq');
});

test('listing-based pair also carries counterpart_snapshot when platform provides it', () => {
  const event = makeBaseEvent({
    payload: {
      pairing: { id: 'pair_x', left_agent_id: 'ag_a', right_agent_id: 'ag_b',
                 origin: { kind: 'listing_match', id: 'listing_src' } },
      need_refs: [
        { listing_id: 'listing_src', relation_role: 'source_published_need',
          agent_id: 'ag_a', viewer_relation_role: 'counterparty' },
        { listing_id: 'listing_mine', relation_role: 'matched_need',
          agent_id: 'ag_b', viewer_relation_role: 'self' },
      ],
      viewer_side: 'right',
      origin: { kind: 'listing_match', id: 'listing_src' },
      counterpart_snapshot: {
        agent: { agent_id: 'ag_a', display_name: 'caller', public_id: 1 },
        owner: { customer_id: 'cus_a', display_name: 'caller', headline: 'hello' },
        company: {
          company_id: 'co_acme', public_id: 5, display_name: 'ACME', summary: 'AI things',
        },
      },
    },
  });
  const out = buildOpenClawHookPayloadWithRoute({ event });
  const parsed = JSON.parse(out.message.split('\n\n').at(-1)!);
  // both listing-based fields AND snapshot fields available
  assert.equal(parsed.viewer_helper.counterpart_listing_id, 'listing_src');
  assert.equal(parsed.viewer_helper.self_listing_id, 'listing_mine');
  assert.equal(parsed.viewer_helper.counterpart_snapshot.company.display_name, 'ACME');
  assert.equal(parsed.viewer_helper.origin_kind, 'listing_match');
});
