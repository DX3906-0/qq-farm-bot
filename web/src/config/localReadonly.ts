// Local viewing is an explicit build flavor AND a fixed loopback origin. It is
// not a query-string switch, an admin session, or a production auth bypass.
export function allowsLocalReadonly(buildEnabled: boolean, href: string) {
  if (!buildEnabled)
    return false
  try {
    const url = new URL(href)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '4177'
  }
  catch { return false }
}
export function accountDataEmptyState(localReadonly: boolean, accountId: string | null | undefined) {
  if (localReadonly) return { title: '本地仅查看界面', description: '账号数据不可用；不会登录账号或进行游戏操作。' }
  return accountId ? { title: '账号数据尚未读取', description: '请确认账号在线，再刷新查看最新进度。' }
    : { title: '选择账号后查看进度', description: '在右上角选择账号，即可查看对应的真实进度。' }
}
export const LOCAL_UI_READONLY = allowsLocalReadonly(
  typeof __LOCAL_UI_READONLY__ !== 'undefined' && __LOCAL_UI_READONLY__ === true,
  typeof window !== 'undefined' ? window.location.href : '',
)
