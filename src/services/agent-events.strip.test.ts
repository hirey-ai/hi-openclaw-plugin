import assert from 'node:assert/strict';
import { test } from 'node:test';

import { __testing_deliverEventToHooks } from './agent-events.js';
import { setPushInjectionActive, isPushInjectionActive } from './push-injection-state.js';

// 修 "定期刷新把最后更新刷没了"：/hooks/agent 是 isolated+forceNew，传入用户真实 sessionKey
// 会 rotate 它的 transcript。strip 现在是**无条件**的——即使 push-injection 未激活
// （旧版只在激活时 strip，未激活时携带 sessionKey 投递 = rotation bug）。

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
} as any;

async function captureDeliveredBody(event: any): Promise<any> {
  const orig = globalThis.fetch;
  let captured: any = null;
  (globalThis as any).fetch = async (_url: string, init: any) => {
    captured = JSON.parse(String(init?.body || '{}'));
    return { ok: true, status: 200, text: async () => 'ok' } as any;
  };
  try {
    await __testing_deliverEventToHooks({
      hooksUrl: 'http://127.0.0.1:18789/hooks/agent',
      hooksToken: 't',
      event,
      stateDir: '/tmp/hi-openclaw-strip-test',
      logger: noopLogger,
    });
  } finally {
    (globalThis as any).fetch = orig;
  }
  return captured;
}

const eventWithRealSession = {
  event_id: 'evt_strip_1',
  topic: 'agent.message.created',
  reply_route_snapshot: { session_key: 'agent:main:main' }, // 用户真实主会话
  preview: { text: 'hi', actor_agent_id: 'ag_dongxu' },
  payload: { message: { source_agent_id: 'ag_dongxu', target_agent_id: 'ag_walter' } },
};

test('sessionKey is stripped before /hooks/agent even when push-injection INACTIVE', async () => {
  const before = isPushInjectionActive();
  setPushInjectionActive(false);
  try {
    const body = await captureDeliveredBody(eventWithRealSession);
    assert.ok(body, 'fetch should have been called');
    assert.equal(body.sessionKey, undefined, 'user real sessionKey must NOT be sent to /hooks/agent');
    // channel-send 字段照常保留（OpenClaw 仍能在 isolated session 里把输出送到用户）
    assert.equal(body.deliver, true);
  } finally {
    setPushInjectionActive(before);
  }
});

test('sessionKey is also stripped when push-injection ACTIVE', async () => {
  const before = isPushInjectionActive();
  setPushInjectionActive(true);
  try {
    const body = await captureDeliveredBody(eventWithRealSession);
    assert.equal(body.sessionKey, undefined, 'user real sessionKey must NOT be sent to /hooks/agent');
  } finally {
    setPushInjectionActive(before);
  }
});
