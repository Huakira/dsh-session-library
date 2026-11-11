import { failure, readPluginPost, sendJson } from './plugin-request.mjs'
import { validSessionId, validTrashId } from './fs-safety.mjs'

export function createLibraryRequestHandlers({ isTrustedRequest = () => false, trash, list, restore, preview }) {
  const execute = (operation, validate, confirmation, errorCode) => async (req, res) => {
    const body = await readPluginPost(req, res, isTrustedRequest, confirmation)
    if (body === undefined) return
    const invalid = validate(body)
    if (invalid) { sendJson(res, 400, failure('invalid-request', invalid)); return }
    const controller = new AbortController()
    const abort = () => controller.abort(new Error('request closed'))
    // Mutations run to completion even if a client disconnects. Read-only preview
    // can suppress a reply after cancellation, but cannot terminate a trash move.
    if (!confirmation) {
      req.once?.('aborted', abort)
      res.once?.('close', abort)
    }
    try {
      const result = await operation(body, controller.signal)
      if (controller.signal.aborted) return
      sendJson(res, result?.ok === false ? 409 : 200, result?.ok === undefined ? { ok: true, value: result } : result)
    } catch {
      if (!controller.signal.aborted) sendJson(res, 503, failure(errorCode, '操作暂不可用；未确认任何数据移动。'))
    } finally {
      req.off?.('aborted', abort)
      res.off?.('close', abort)
    }
  }
  return {
    trash: execute(body => trash(body.sessionId, body.expectedArchived), body => !validSessionId(body?.sessionId)
      || (body.expectedArchived !== undefined && typeof body.expectedArchived !== 'boolean') ? '会话参数无效。' : '', 'trash-session', 'trash-unavailable'),
    list: execute(() => list(), body => body === null || typeof body !== 'object' || Array.isArray(body) ? '需要 JSON 对象。' : '', undefined, 'trash-list-unavailable'),
    restore: execute(body => restore(body.trashId), body => !validTrashId(body?.trashId) ? '回收站 ID 无效。' : '', 'restore-trash', 'restore-unavailable'),
    preview: execute((body, signal) => preview(body.sessionId, signal), body => !validSessionId(body?.sessionId) ? '会话 ID 无效。' : '', undefined, 'preview-unavailable'),
  }
}
