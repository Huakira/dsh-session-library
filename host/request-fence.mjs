// Host fencing adapted from dsh-chat-manager, Copyright (c) 2026 WSL043, MIT; see NOTICE.
export function hostRequestFence(connection) {
  if (typeof connection?.requestRejection !== 'function') return () => false
  return req => {
    const rejection = connection.requestRejection(req)
    return rejection === undefined ? true : rejection
  }
}
