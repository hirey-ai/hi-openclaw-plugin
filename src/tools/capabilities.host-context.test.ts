// Unit tests for capabilities.ts host-context injection. Implements Cursor plan
// hi_openclaw会话绑定 todo #5 (host-surface-origin-capture) on the plugin side: when a
// capability tool's execute runs, the OpenClaw runtime ctx (sessionKey,
// deliveryContext) gets injected into _ctx of the platform request so the platform's
// extractHostReplyRoute (src/services/agentReplyRoutes.ts) can persist a per-workflow
// reply-route binding instead of falling back to the "most recent session" heuristic.
//
// We test enrichParamsWithHostContext directly as a pure function — testing through
// the full execute path would require mocking buildAuthorizedClients which is
// awkward in ESM (modules are immutable). The pure function is the entire decision
// surface; the wrapping execute() just calls platform.callCapability with whatever
// this function returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichParamsWithHostContext } from './capabilities.js';
import type { PluginToolContext } from '../types.js';

test('runtime ctx with sessionKey injects _ctx.host_session_key + host_reply_route', () => {
  const ctx: PluginToolContext = {
    sessionKey: 'agent:main:telegram:default:direct:walter-123',
    deliveryContext: { channel: 'telegram', to: '123', accountId: 'default' },
  };
  const out = enrichParamsWithHostContext({ action: 'list', foo: 'bar' }, ctx);
  assert.equal(out.foo, 'bar', 'preserves LLM params');
  assert.equal(out.action, 'list', 'preserves LLM params');
  const _ctx = out._ctx as Record<string, unknown>;
  assert.ok(_ctx, '_ctx injected');
  assert.equal(_ctx.host_session_key, 'agent:main:telegram:default:direct:walter-123');
  const hrr = _ctx.host_reply_route as Record<string, unknown>;
  assert.equal(hrr.session_key, 'agent:main:telegram:default:direct:walter-123');
  const dc = hrr.delivery_context as Record<string, unknown>;
  assert.equal(dc.channel, 'telegram');
  assert.equal(dc.to, '123');
  assert.equal(dc.account_id, 'default');
});

test('empty runtime ctx leaves _ctx absent', () => {
  const out = enrichParamsWithHostContext({ action: 'list' }, {});
  assert.equal(out._ctx, undefined);
  assert.equal(out.action, 'list');
});

test('runtime sessionKey overrides LLM-supplied _ctx.host_session_key (trust runtime)', () => {
  const ctx: PluginToolContext = { sessionKey: 'agent:main:imessage:direct:+86000' };
  const out = enrichParamsWithHostContext(
    {
      action: 'do_it',
      _ctx: {
        host_session_key: 'agent:main:HIJACKED',
        host_reply_route: { session_key: 'agent:main:HIJACKED' },
        extra_field: 'preserve_me',
      },
    },
    ctx,
  );
  const _ctx = out._ctx as Record<string, unknown>;
  assert.equal(_ctx.host_session_key, 'agent:main:imessage:direct:+86000', 'runtime wins');
  const hrr = _ctx.host_reply_route as Record<string, unknown>;
  assert.equal(hrr.session_key, 'agent:main:imessage:direct:+86000', 'runtime wins on nested');
  assert.equal(_ctx.extra_field, 'preserve_me', 'unrelated LLM _ctx fields preserved');
});

test('LLM _ctx without route fields and empty runtime ctx → leaves LLM _ctx untouched', () => {
  const out = enrichParamsWithHostContext(
    { action: 'x', _ctx: { extra_field: 'keep' } },
    {},
  );
  // Since runtime ctx is empty, we early-return base with LLM _ctx intact.
  assert.equal((out._ctx as any)?.extra_field, 'keep');
});

test('runtime ctx with only deliveryContext (no sessionKey) still injects host_reply_route', () => {
  const ctx: PluginToolContext = {
    deliveryContext: { channel: 'imessage', to: 'imessage:+86001', accountId: 'default' },
  };
  const out = enrichParamsWithHostContext({ action: 'x' }, ctx);
  const _ctx = out._ctx as Record<string, unknown>;
  assert.equal(_ctx.host_session_key, undefined, 'no host_session_key when sessionKey absent');
  const hrr = _ctx.host_reply_route as Record<string, unknown>;
  assert.ok(hrr, 'host_reply_route injected when delivery context present');
  const dc = hrr.delivery_context as Record<string, unknown>;
  assert.equal(dc.channel, 'imessage');
  assert.equal(dc.to, 'imessage:+86001');
  assert.equal(dc.account_id, 'default');
});

test('whitespace-only runtime sessionKey treated as absent', () => {
  const out = enrichParamsWithHostContext({ action: 'x' }, { sessionKey: '   ' });
  assert.equal(out._ctx, undefined);
});

test('array params replaced with object (defensive against bad LLM input)', () => {
  const out = enrichParamsWithHostContext(
    ['unexpected'] as unknown as Record<string, unknown>,
    { sessionKey: 'agent:main:main' },
  );
  assert.equal(Array.isArray(out), false);
  const _ctx = out._ctx as Record<string, unknown>;
  assert.equal(_ctx.host_session_key, 'agent:main:main');
});

test('null params handled without crash', () => {
  const out = enrichParamsWithHostContext(null, { sessionKey: 'agent:main:main' });
  const _ctx = out._ctx as Record<string, unknown>;
  assert.equal(_ctx.host_session_key, 'agent:main:main');
});

test('undefined params handled without crash', () => {
  const out = enrichParamsWithHostContext(undefined, { sessionKey: 'agent:main:main' });
  const _ctx = out._ctx as Record<string, unknown>;
  assert.equal(_ctx.host_session_key, 'agent:main:main');
});

test('empty string fields in deliveryContext are dropped (only non-empty preserved)', () => {
  const ctx: PluginToolContext = {
    sessionKey: 'agent:main:main',
    deliveryContext: { channel: 'imessage', to: '   ', accountId: '', threadId: 'thread-1' },
  };
  const out = enrichParamsWithHostContext({}, ctx);
  const hrr = (out._ctx as any).host_reply_route as Record<string, unknown>;
  const dc = hrr.delivery_context as Record<string, unknown>;
  assert.equal(dc.channel, 'imessage');
  assert.equal(dc.to, undefined, 'whitespace-only to dropped');
  assert.equal(dc.account_id, undefined, 'empty account_id dropped');
  assert.equal(dc.thread_id, 'thread-1');
});

test('does not mutate original params object', () => {
  const original = { action: 'list' };
  enrichParamsWithHostContext(original, { sessionKey: 'agent:main:main' });
  assert.equal((original as any)._ctx, undefined, 'original is not mutated');
});
