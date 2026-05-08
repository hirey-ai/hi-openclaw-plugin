// 把 hi-agent-sdk / fetch / 任意 catch 里的 error 对象拍平成 LLM-friendly 的诊断字段。
//
// 为什么需要这个 util：
// - hi-agent-sdk 的 BaseHiClient.request 在收到 4xx 时 throw 一个 Error，把 platform 返回的
//   完整 JSON body 挂到 err.detail（含 422 校验诊断如 `{ missing: [...], required_for_action,
//   path }`），HTTP status 挂到 err.status；err.message 只是 body.error 字段的浅复制。
// - 之前 plugin 的 tool execute 路径在 catch 里只 surface `String(err.message)`，等同于把
//   platform 那侧专门为 LLM self-recovery 准备的结构化诊断 swallow 掉。LLM 收到 tool result
//   只剩一句 "missing fields"，没法知道缺哪个字段，在 owner 面前只能干说"看不到具体缺哪个
//   字段"陷入盲调死循环。
// - 这个 helper 把 err.message + err.status + err.detail 一并 surface 出去；如果 err 没
//   .detail（fs / dns / 网络层等非 SDK 错误），就只 surface message，行为退化但不丢信息。
//
// 14 个 capability tool + 5 个 control tool 全部走这个 util，一处 fix 修完一类问题。
// 未来加新 tool 时务必继续走这个 util 而不要 inline `String(err?.message || err)`。

export type ErrorDetailFields = {
  error_message: string;
  status?: number;
  platform_response?: unknown;
};

export function buildErrorDetailFields(err: unknown): ErrorDetailFields {
  const message = String((err as any)?.message || err || 'unknown_error');
  const out: ErrorDetailFields = { error_message: message };
  if (err && typeof err === 'object') {
    const status = (err as any).status;
    if (typeof status === 'number') out.status = status;
    const platformDetail = (err as any).detail;
    // detail === undefined 时不 surface 这个字段（避免给 LLM 看到 `platform_response: null`
    // 误解为"平台返回 null"）；只要 detail 存在（包括 detail === null 这种 SDK 显式 null），
    // 就一并暴露原始 body，让 LLM 自己解构。
    if (platformDetail !== undefined) out.platform_response = platformDetail;
  }
  return out;
}
