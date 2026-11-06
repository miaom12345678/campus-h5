/** 通用小工具 */

export function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 时间戳 → 2024-05-01 */
export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 时间戳 → 05-01 14:30 */
export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 时间戳 → 刚刚 / 3小时前 / 2天前 */
export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return formatDate(ts);
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return Math.floor(diff / min) + '分钟前';
  if (diff < day) return Math.floor(diff / hour) + '小时前';
  if (diff < 30 * day) return Math.floor(diff / day) + '天前';
  return formatDate(ts);
}

/** 帖子一句话标题 */
export function postTitle(post) {
  if (!post) return '';
  const t = post.type === 'lost' ? '丢失' : '捡到';
  const color = post.color && post.color !== '不清楚' ? post.color : '';
  return t + '：' + color + (post.category || '物品');
}

export const STATUS_LABEL = {
  active: '进行中',
  claimed: '已认领',
  closed: '已关闭'
};

export function statusText(status) {
  return STATUS_LABEL[status] || '进行中';
}

/**
 * 匹配分 → 档位，用于列表徽章与文案
 *   >= 85 高度匹配（强烈建议优先看）
 *   70~84 较匹配
 *   60~69 可能匹配（刚过推送阈值）
 *   < 60  不推送
 */
export function scoreLevel(score) {
  if (score >= 85) return 'high';
  if (score >= 70) return 'mid';
  if (score >= 60) return 'low';
  return 'none';
}

export function levelText(score) {
  if (score >= 85) return '高度匹配';
  if (score >= 70) return '较匹配';
  if (score >= 60) return '可能匹配';
  return '';
}


  formatDate,
  formatDateTime,
  relativeTime,
  postTitle,
  statusText,
  scoreLevel,
  levelText
};
