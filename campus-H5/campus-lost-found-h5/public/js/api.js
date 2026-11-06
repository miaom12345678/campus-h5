/** 前端 API 封装：自动带上用户身份（localStorage uid），统一处理错误 */
const UID_KEY = 'clf_uid';

export function getUid() {
  let uid = '';
  try { uid = localStorage.getItem(UID_KEY) || ''; } catch (e) { /* ignore */ }
  if (!uid) {
    uid = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem(UID_KEY, uid); } catch (e) { /* ignore */ }
  }
  return uid;
}

async function call(path, data, method) {
  const opts = {
    method: method || (data ? 'POST' : 'GET'),
    headers: { 'x-user-id': getUid() }
  };
  if (data) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  const res = await fetch('/api/' + path, opts);
  const json = await res.json().catch(() => ({ ok: false, errMsg: '网络错误，请稍后重试' }));
  return json;
}

export const api = {
  login: () => call('login'),
  unreadCount: () => call('unread-count'),
  messages: () => call('messages'),
  readMessage: (messageId) => call('message-read', { messageId }),
  readByPost: (postId) => call('message-read-post', { postId }),
  readAll: () => call('message-read-all'),
  getProfile: () => call('profile'),
  saveProfile: (p) => call('profile?op=save', p),
  search: (filters, page, pageSize) => call('search', { filters, page, pageSize }),
  postDetail: (postId) => call('post-detail', { postId }),
  publish: (post) => call('publish', { post }),
  claimCreate: (postId, message, contact) => call('claim-create', { postId, message, contact }),
  claimAccept: (claimId) => call('claim-accept', { claimId }),
  claimReject: (claimId) => call('claim-reject', { claimId }),
  closePost: (postId) => call('close-post', { postId }),
  myPosts: () => call('my-posts'),
  incoming: () => call('incoming'),
  outgoing: () => call('outgoing'),
  repairPoints: (dryRun) => call('repair-points', { dryRun: !!dryRun }),
  rewardSummary: () => call('reward-summary'),
  rewardCoupons: (status) => call('reward-coupons', { status }),
  rewardExchange: () => call('reward-exchange'),
  rewardVerify: (code) => call('reward-verify', { code }),
  rewardGrant: (points) => call('reward-grant', { points }),
  seed: () => call('seed'),
  clear: () => call('clear')
};
