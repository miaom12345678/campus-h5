/**
 * Vercel Serverless 后端（catch-all）：/api/<action>
 * ------------------------------------------------
 * 由微信小程序的 7 个云函数改写而来：
 *   searchPosts / publishPost / getMessages / claimPost / reward / seedDemo / sendNotify(跳过)
 *
 * 用户身份：微信 openid 在 H5 里不存在，改用前端 localStorage 生成的
 * 随机 uid，通过请求头 x-user-id 传递（演示级身份方案）。
 *
 * 动作清单（与小程序端 wx.cloud.callFunction 一一对应）：
 *   /api/login            /api/unread-count   /api/messages      /api/message-read
 *   /api/message-read-post /api/message-read-all /api/profile
 *   /api/search           /api/post-detail    /api/publish
 *   /api/claim-create     /api/claim-accept   /api/claim-reject  /api/close-post
 *   /api/my-posts         /api/incoming       /api/outgoing      /api/repair-points
 *   /api/reward-summary   /api/reward-coupons /api/reward-exchange /api/reward-verify /api/reward-grant
 *   /api/seed             /api/clear
 */
const { loadDB, saveDB, genId } = require('./_lib/store');
const { computeMatchScore, normalize } = require('./_lib/match');

const COUPON_COST = 2;
const DAILY_EXCHANGE_LIMIT = 3;
const MIN_INTERVAL_MS = 60 * 1000;
const DAILY_LIMIT = 5;
const MAX_LOCATION = 3;
const MATCH_WINDOW_DAYS = 180;
const DAY = 24 * 60 * 60 * 1000;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// ==================== 工具 ====================
function levelOf(score) {
  if (score >= 85) return { level: 'high', levelText: '高度匹配' };
  if (score >= 70) return { level: 'mid', levelText: '较匹配' };
  if (score >= 60) return { level: 'low', levelText: '可能匹配' };
  return { level: 'none', levelText: '' };
}

function sanitize(post) {
  if (!post) return null;
  const out = Object.assign({}, post);
  delete out.contact;
  delete out.sensitive;
  delete out.userId;
  return out;
}

function maskIdTail(raw) {
  const s = String(raw || '').replace(/[^0-9a-zA-Z]/g, '');
  if (!s) return '';
  return s.length <= 4 ? s : '****' + s.slice(-4);
}

function genCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 读 / 建用户档案 */
function upsertUser(db, uid, patch) {
  const now = Date.now();
  let u = db.users.find((x) => x.openid === uid);
  if (!u) {
    u = Object.assign(
      { _id: genId('u'), openid: uid, points: 0, email: '', notifyEmail: false, phone: '', notifySms: false, createTime: now },
      patch || {}
    );
    u.updateTime = now;
    db.users.push(u);
  } else if (patch && Object.keys(patch).length) {
    Object.assign(u, patch, { updateTime: now });
  }
  return u;
}

function pushMessage(db, msg) {
  db.messages.push(Object.assign({ _id: genId('m'), read: false, createTime: Date.now() }, msg));
}

function markMessagesRead(db, postId, userIds) {
  let n = 0;
  for (const m of db.messages) {
    if (m.postId !== postId || m.read) continue;
    if (userIds && userIds.length && userIds.indexOf(m.toUserId) === -1) continue;
    m.read = true;
    n++;
  }
  return n;
}

function pickLocations(raw) {
  let list = [];
  if (Array.isArray(raw.locations) && raw.locations.length) {
    list = raw.locations
      .filter((l) => l && l.campus)
      .slice(0, MAX_LOCATION)
      .map((l) => ({ campus: String(l.campus || '').trim(), building: String(l.building || '').trim() }));
  }
  if (!list.length && raw.campus) {
    list = [{ campus: String(raw.campus || '').trim(), building: String(raw.building || '').trim() }];
  }
  return list;
}

function pickPost(raw) {
  const locations = pickLocations(raw);
  const eventTime = Number(raw.eventTime) || 0;
  let eventTimeEnd = Number(raw.eventTimeEnd) || 0;
  if (eventTimeEnd && eventTimeEnd < eventTime) eventTimeEnd = 0;
  const post = {
    type: raw.type === 'lost' ? 'lost' : 'found',
    category: String(raw.category || '').trim(),
    color: String(raw.color || '').trim() || '不确定/不适用',
    brand: String(raw.brand || '').trim(),
    campus: locations.length ? locations[0].campus : '',
    building: locations.length ? locations[0].building : '',
    locations,
    locationUnknown: !!raw.locationUnknown,
    eventTime,
    eventTimeEnd,
    timeUnknown: !!raw.timeUnknown,
    description: String(raw.description || '').trim(),
    images: Array.isArray(raw.images) ? raw.images.slice(0, 6) : [],
    contact: {
      wechat: String((raw.contact && raw.contact.wechat) || '').trim(),
      phone: String((raw.contact && raw.contact.phone) || '').trim()
    }
  };
  const idRaw = String((raw.sensitive && raw.sensitive.idNumber) || '').trim();
  if (idRaw) {
    post.sensitive = { idNumber: idRaw };
    post.idTail = maskIdTail(idRaw);
  }
  return post;
}

function addPoints(db, uid, delta) {
  const u = upsertUser(db, uid);
  u.points = (Number(u.points) || 0) + delta;
  u.updateTime = Date.now();
  return true;
}

// ==================== 动作实现 ====================
const handlers = {
  // ---------- 登录 / 消息 ----------
  login(ctx) {
    const profile = upsertUser(ctx.db, ctx.uid);
    return { ok: true, openid: ctx.uid, profile: pickProfile(profile) };
  },

  'unread-count'(ctx) {
    const count = ctx.db.messages.filter((m) => m.toUserId === ctx.uid && !m.read).length;
    return { ok: true, count };
  },

  messages(ctx) {
    const msgs = ctx.db.messages
      .filter((m) => m.toUserId === ctx.uid)
      .sort((a, b) => b.createTime - a.createTime)
      .slice(0, 100);
    const postMap = {};
    msgs.forEach((m) => {
      [m.postId, m.matchPostId].forEach((id) => {
        if (!id || postMap[id]) return;
        const p = ctx.db.posts.find((x) => x._id === id);
        if (p) postMap[id] = sanitize(p);
      });
    });
    return {
      ok: true,
      total: msgs.length,
      list: msgs.map((m) => ({
        _id: m._id,
        type: m.type || 'match',
        claimId: m.claimId || '',
        note: m.note || '',
        score: m.score || 0,
        reasons: m.reasons || [],
        read: !!m.read,
        createTime: m.createTime,
        myPost: postMap[m.postId] || null,
        matchPost: postMap[m.matchPostId] || null
      }))
    };
  },

  'message-read'(ctx) {
    const m = ctx.db.messages.find((x) => x._id === ctx.q.messageId);
    if (!m) return { ok: false, errMsg: '消息不存在' };
    m.read = true;
    return { ok: true };
  },

  'message-read-post'(ctx) {
    const updated = markMessagesRead(ctx.db, ctx.q.postId, [ctx.uid]);
    return { ok: true, updated };
  },

  'message-read-all'(ctx) {
    let updated = 0;
    for (const m of ctx.db.messages) {
      if (m.toUserId === ctx.uid && !m.read) {
        m.read = true;
        updated++;
      }
    }
    return { ok: true, updated };
  },

  profile(ctx) {
    if (ctx.q.op === 'save') {
      const patch = {
        email: String(ctx.q.email || '').trim(),
        notifyEmail: !!ctx.q.notifyEmail,
        phone: String(ctx.q.phone || '').trim(),
        notifySms: !!ctx.q.notifySms
      };
      const u = upsertUser(ctx.db, ctx.uid, patch);
      return { ok: true, profile: pickProfile(u) };
    }
    const u = upsertUser(ctx.db, ctx.uid);
    return { ok: true, profile: pickProfile(u) };
  },

  // ---------- 搜索 ----------
  search(ctx) {
    const filters = ctx.q.filters || {};
    const page = Number(ctx.q.page) || 1;
    const pageSize = Number(ctx.q.pageSize) || 20;

    let list = ctx.db.posts.filter((p) => p.status === (filters.status || 'active'));
    if (filters.type && filters.type !== 'all') list = list.filter((p) => p.type === filters.type);
    if (filters.category) list = list.filter((p) => p.category === filters.category);
    if (filters.campus) list = list.filter((p) => p.campus === filters.campus);
    if (filters.color) list = list.filter((p) => p.color === filters.color);
    list.sort((a, b) => (b.createTime || 0) - (a.createTime || 0));

    if (Array.isArray(filters.buildings) && filters.buildings.length) {
      const want = filters.buildings.map(String);
      list = list.filter((p) => {
        const locs = (p.locations && p.locations.length ? p.locations : p.building ? [{ building: p.building }] : []);
        return locs.some((l) => want.indexOf(l.building) >= 0);
      });
    }

    const kw = normalize(filters.keyword || '');
    if (kw) {
      list = list.filter((p) => {
        const locText = Array.isArray(p.locations) ? p.locations.map((l) => l.building || '').join(' ') : '';
        const hay = normalize([p.description, p.brand, p.category, p.color, p.campus, p.building, p.idTail || '', locText].join(' '));
        return hay.indexOf(kw) !== -1;
      });
    }

    // 从关键词里认出颜色与类别（与小程序云函数一致）
    const COLOR_LIST = ['黑色', '白色', '灰色/银色', '金色/香槟', '蓝色', '红色', '绿色', '黄色/橙色', '粉色', '紫色', '棕色/卡其', '透明', '花色/多色'];
    const CATEGORY_LIST = ['校园卡/一卡通', '身份证', '学生证/证件', '手机', '耳机', '充电宝/充电器', '电脑/平板', '钥匙', '钱包/卡包', '水杯', '雨伞', '书本/笔记', '背包/袋子', '眼镜', '手表', '衣物', '运动器材', '洗漱/化妆品', '其他'];
    const guess = {};
    if (kw) {
      for (const c of COLOR_LIST) if (kw.indexOf(normalize(c)) >= 0) { guess.color = c; break; }
      for (const c of CATEGORY_LIST) if (kw.indexOf(normalize(c)) >= 0) { guess.category = c; break; }
    }

    const hasFilter = !!(filters.category || filters.color || filters.campus || filters.building || filters.eventTime || kw);
    const scored = list.map((p) => {
      if (!hasFilter) return { post: p, score: 0, reasons: [] };
      const ref = {
        type: p.type === 'lost' ? 'found' : 'lost',
        category: filters.category || guess.category || '',
        color: filters.color || guess.color || '',
        brand: filters.brand || '',
        campus: filters.campus || '',
        building: filters.building || '',
        eventTime: Number(filters.eventTime) || 0,
        description: filters.description || filters.keyword || ''
      };
      const r = computeMatchScore(ref, p);
      return { post: p, score: r.score, reasons: r.reasons };
    });

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : (b.post.createTime || 0) - (a.post.createTime || 0)));
    const start = (page - 1) * pageSize;
    const pageList = scored.slice(start, start + pageSize);
    return {
      ok: true,
      total: scored.length,
      page,
      pageSize,
      hasMore: start + pageSize < scored.length,
      list: pageList.map((item) => Object.assign({}, sanitize(item.post), {
        isMine: item.post.userId === ctx.uid,
        matchScore: item.score,
        matchReasons: item.reasons,
        matchLevel: levelOf(item.score).level,
        matchLevelText: levelOf(item.score).levelText
      }))
    };
  },

  'post-detail'(ctx) {
    const post = ctx.db.posts.find((p) => p._id === ctx.q.postId);
    if (!post) return { ok: false, errMsg: '帖子不存在或已删除' };
    const isMine = post.userId === ctx.uid;
    let contactVisible = isMine;
    let claimStatus = '';
    if (!isMine) {
      const c = ctx.db.claims.find((x) => x.postId === post._id && x.claimerId === ctx.uid);
      if (c) {
        claimStatus = c.status;
        if (c.status === 'accepted') contactVisible = true;
      }
    }
    const safe = sanitize(post);
    safe.isMine = isMine;
    if (isMine) safe.idNumber = post.sensitive ? post.sensitive.idNumber : undefined;
    return { ok: true, post: safe, isMine, contactVisible, contact: contactVisible ? post.contact : null, claimStatus };
  },

  // ---------- 发布 ----------
  publish(ctx) {
    const post = pickPost(ctx.q.post || {});
    if (!post.category) return { ok: false, errMsg: '请选择物品类别' };
    if (!post.locations.length) return { ok: false, errMsg: '请至少选择一个地点' };
    if (!post.eventTime) return { ok: false, errMsg: '请选择时间' };
    if (!post.description && !post.brand && !post.sensitive) return { ok: false, errMsg: '请填写物品特征描述' };
    if (!post.contact.wechat && !post.contact.phone) return { ok: false, errMsg: '请至少填写一种联系方式' };

    const now = Date.now();
    const mine = ctx.db.posts.filter((p) => p.userId === ctx.uid);
    if (mine.some((p) => now - p.createTime < MIN_INTERVAL_MS)) {
      return { ok: false, errMsg: '发布太频繁了，请 60 秒后再发一条' };
    }
    if (mine.filter((p) => now - p.createTime < DAY).length >= DAILY_LIMIT) {
      return { ok: false, errMsg: '每天最多发布 ' + DAILY_LIMIT + ' 条，请明天再来' };
    }

    const doc = Object.assign({}, post, {
      _id: genId('p'),
      userId: ctx.uid,
      status: 'active',
      createTime: now,
      updateTime: now
    });
    ctx.db.posts.push(doc);

    // ---- 反向匹配 ----
    const oppositeType = post.type === 'lost' ? 'found' : 'lost';
    const candidates = ctx.db.posts
      .filter((p) => p.type === oppositeType && p.status === 'active' && p.userId !== ctx.uid && (p.eventTime || 0) >= now - MATCH_WINDOW_DAYS * DAY)
      .sort((a, b) => (b.eventTime || 0) - (a.eventTime || 0))
      .slice(0, 200);

    const hits = [];
    for (const c of candidates) {
      const r = computeMatchScore(post, c);
      if (r.hit) {
        const lv = levelOf(r.score);
        hits.push({
          postId: c._id,
          toUserId: c.userId,
          score: r.score,
          level: lv.level,
          levelText: lv.levelText,
          reasons: r.reasons,
          summary: {
            _id: c._id,
            type: c.type,
            category: c.category,
            color: c.color,
            campus: c.campus,
            building: c.building,
            locations: c.locations || [],
            description: c.description,
            idTail: c.idTail || '',
            images: c.images || []
          }
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);

    let inserted = 0;
    for (const h of hits) {
      const dup = ctx.db.messages.some((m) => m.postId === h.postId && m.matchPostId === doc._id);
      if (dup) continue;
      pushMessage(ctx.db, {
        toUserId: h.toUserId,
        postId: h.postId,
        matchPostId: doc._id,
        fromUserId: ctx.uid,
        score: h.score,
        reasons: h.reasons
      });
      inserted++;
    }

    const highHits = hits.filter((h) => h.score >= 85);
    const topMatches = highHits.length ? highHits.slice(0, 8) : hits.slice(0, 3);
    return { ok: true, postId: doc._id, matchCount: inserted, highCount: highHits.length, topMatches };
  },

  // ---------- 认领 ----------
  'claim-create'(ctx) {
    const post = ctx.db.posts.find((p) => p._id === ctx.q.postId);
    if (!post) return { ok: false, errMsg: '帖子不存在' };
    if (post.userId === ctx.uid) return { ok: false, errMsg: '这是你自己发布的帖子' };
    if (post.status !== 'active') return { ok: false, errMsg: '该帖子已结束' };
    if (ctx.db.claims.some((c) => c.postId === post._id && c.claimerId === ctx.uid && c.status === 'pending')) {
      return { ok: false, errMsg: '你已发起过申请，请等待对方处理' };
    }
    const note = String(ctx.q.message || '').trim();
    const claim = {
      _id: genId('c'),
      postId: post._id,
      ownerId: post.userId,
      claimerId: ctx.uid,
      postType: post.type,
      postCategory: post.category || '',
      message: note,
      claimerContact: {
        wechat: String((ctx.q.contact && ctx.q.contact.wechat) || '').trim(),
        phone: String((ctx.q.contact && ctx.q.contact.phone) || '').trim()
      },
      status: 'pending',
      createTime: Date.now()
    };
    ctx.db.claims.push(claim);
    pushMessage(ctx.db, {
      toUserId: post.userId,
      type: 'claim',
      claimId: claim._id,
      postId: post._id,
      score: 0,
      reasons: ['有人申请认领你的「' + post.category + '」'],
      note
    });
    return { ok: true, claimId: claim._id };
  },

  'claim-accept'(ctx) {
    const claim = ctx.db.claims.find((c) => c._id === ctx.q.claimId);
    if (!claim) return { ok: false, errMsg: '申请不存在' };
    if (claim.ownerId !== ctx.uid) return { ok: false, errMsg: '无权处理他人的申请' };
    if (claim.status !== 'pending') return { ok: false, errMsg: '该申请已处理过' };

    const now = Date.now();
    claim.status = 'accepted';
    claim.updateTime = now;
    claim.pairKey = [claim.ownerId, claim.claimerId].sort().join('_');

    // 积分：只给捡到东西的一方，同一对熟人只计一次
    let credited = false;
    let finderId = '';
    let pointError = '';
    const alreadyCredited = ctx.db.claims.some((c) => c.pairKey === claim.pairKey && c.credited && c._id !== claim._id);
    if (alreadyCredited) {
      pointError = '这一对同学之间已经计过一次积分了（防刷），本次不再重复加分';
    } else {
      const post = ctx.db.posts.find((p) => p._id === claim.postId);
      const postType = claim.postType || (post ? post.type : '');
      finderId = postType === 'found' ? claim.ownerId : claim.claimerId;
      if (finderId) {
        addPoints(ctx.db, finderId, 1);
        claim.credited = true;
        claim.pointTo = finderId;
        credited = true;
      }
    }

    const post = ctx.db.posts.find((p) => p._id === claim.postId);
    if (post) {
      post.status = 'claimed';
      post.updateTime = now;
      if (credited) post.pointCredited = true;
    }
    // 拒绝同帖其他待处理申请
    for (const c of ctx.db.claims) {
      if (c.postId === claim.postId && c.status === 'pending' && c._id !== claim._id) c.status = 'rejected';
    }
    pushMessage(ctx.db, {
      toUserId: claim.claimerId,
      type: 'system',
      claimId: claim._id,
      postId: claim.postId,
      score: 0,
      reasons: ['对方已同意你的认领，联系方式已解锁，请尽快联系']
    });
    markMessagesRead(ctx.db, claim.postId, [claim.ownerId, claim.claimerId]);
    if (credited && finderId) {
      pushMessage(ctx.db, {
        toUserId: finderId,
        type: 'system',
        claimId: claim._id,
        postId: claim.postId,
        score: 0,
        reasons: ['归还成功，获得 1 积分，满 ' + COUPON_COST + ' 分可在「我的 → 餐券」兑换餐券']
      });
    }
    const me = upsertUser(ctx.db, ctx.uid);
    return {
      ok: true,
      credited,
      creditedTo: credited ? (finderId === ctx.uid ? 'me' : 'other') : '',
      pointError,
      myPoints: me.points || 0
    };
  },

  'claim-reject'(ctx) {
    const claim = ctx.db.claims.find((c) => c._id === ctx.q.claimId);
    if (!claim) return { ok: false, errMsg: '申请不存在' };
    if (claim.ownerId !== ctx.uid) return { ok: false, errMsg: '无权处理他人的申请' };
    if (claim.status !== 'pending') return { ok: false, errMsg: '该申请已处理过' };
    claim.status = 'rejected';
    claim.updateTime = Date.now();
    pushMessage(ctx.db, {
      toUserId: claim.claimerId,
      type: 'system',
      claimId: claim._id,
      postId: claim.postId,
      score: 0,
      reasons: ['很遗憾，对方确认后认为不是你的物品']
    });
    return { ok: true };
  },

  'close-post'(ctx) {
    const post = ctx.db.posts.find((p) => p._id === ctx.q.postId);
    if (!post) return { ok: false, errMsg: '帖子不存在' };
    if (post.userId !== ctx.uid) return { ok: false, errMsg: '无权操作他人的帖子' };
    if (post.status !== 'active') return { ok: false, errMsg: '该帖子已结束' };

    let credited = false;
    if (post.type === 'found' && post.pointCredited !== true) {
      addPoints(ctx.db, ctx.uid, 1);
      credited = true;
      post.pointCredited = true;
      post.pointTo = ctx.uid;
    }
    post.status = 'closed';
    post.updateTime = Date.now();
    for (const c of ctx.db.claims) {
      if (c.postId === post._id && c.status === 'pending') c.status = 'rejected';
    }
    markMessagesRead(ctx.db, post._id, [ctx.uid]);
    const me = upsertUser(ctx.db, ctx.uid);
    return { ok: true, credited, myPoints: me.points || 0 };
  },

  'my-posts'(ctx) {
    const list = ctx.db.posts
      .filter((p) => p.userId === ctx.uid)
      .sort((a, b) => b.createTime - a.createTime)
      .map((p) => Object.assign({}, sanitize(p), { isMine: true }));
    return { ok: true, list };
  },

  incoming(ctx) {
    const claims = ctx.db.claims
      .filter((c) => c.ownerId === ctx.uid && !c.selfFinish)
      .sort((a, b) => b.createTime - a.createTime)
      .map((c) => ({
        _id: c._id,
        status: c.status,
        message: c.message,
        createTime: c.createTime,
        post: sanitize(ctx.db.posts.find((p) => p._id === c.postId)) || null,
        claimerContact: c.status === 'accepted' ? c.claimerContact || null : null
      }));
    return { ok: true, list: claims };
  },

  outgoing(ctx) {
    const claims = ctx.db.claims
      .filter((c) => c.claimerId === ctx.uid)
      .sort((a, b) => b.createTime - a.createTime)
      .map((c) => {
        const p = ctx.db.posts.find((x) => x._id === c.postId);
        return {
          _id: c._id,
          status: c.status,
          message: c.message,
          createTime: c.createTime,
          post: sanitize(p) || null,
          contact: c.status === 'accepted' && p ? p.contact || null : null
        };
      });
    return { ok: true, list: claims };
  },

  'repair-points'(ctx) {
    const dryRun = !!ctx.q.dryRun;
    const mine = ctx.db.claims.filter((c) => c.ownerId === ctx.uid || c.claimerId === ctx.uid);
    const donePair = {};
    mine.forEach((c) => {
      if (c.credited && c.pairKey) donePair[c.pairKey] = true;
    });
    const plan = [];
    let already = 0;
    for (const c of mine) {
      if (c.credited === true) { already++; continue; }
      if (c.status !== 'accepted') continue;
      const pk = c.pairKey || [c.ownerId, c.claimerId].sort().join('_');
      if (donePair[pk]) continue;
      const finder = c.postType === 'found' ? c.ownerId : c.claimerId;
      if (!finder) continue;
      plan.push({ claimId: c._id, finder, pairKey: pk });
      donePair[pk] = true;
    }
    // 招领帖已结束但没计过分
    for (const p of ctx.db.posts) {
      if (p.userId !== ctx.uid || p.type !== 'found') continue;
      if ((p.status !== 'closed' && p.status !== 'claimed') || p.pointCredited === true) continue;
      plan.push({ claimId: '', postId: p._id, finder: ctx.uid, pairKey: '' });
    }
    if (dryRun) return { ok: true, willCredit: plan.length, already };

    let credited = 0;
    for (const p of plan) {
      addPoints(ctx.db, p.finder, 1);
      if (p.claimId) {
        const c = ctx.db.claims.find((x) => x._id === p.claimId);
        if (c) { c.credited = true; c.pointTo = p.finder; c.pairKey = p.pairKey; }
      } else if (p.postId) {
        const post = ctx.db.posts.find((x) => x._id === p.postId);
        if (post) { post.pointCredited = true; post.pointTo = p.finder; }
      }
      credited++;
    }
    const me = upsertUser(ctx.db, ctx.uid);
    return { ok: true, credited, myPoints: me.points || 0 };
  },

  // ---------- 积分 / 餐券 ----------
  'reward-summary'(ctx) {
    const u = upsertUser(ctx.db, ctx.uid);
    const points = Number(u.points) || 0;
    const coupons = ctx.db.coupons.filter((c) => c.openid === ctx.uid);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return {
      ok: true,
      points,
      couponCost: COUPON_COST,
      canExchange: Math.floor(points / COUPON_COST),
      dailyLimit: DAILY_EXCHANGE_LIMIT,
      todayExchanged: coupons.filter((c) => c.createTime >= todayStart.getTime()).length,
      returnCount: ctx.db.claims.filter((c) => c.pointTo === ctx.uid && c.credited).length,
      couponTotal: coupons.length,
      couponUnused: coupons.filter((c) => c.status !== 'used').length,
      couponUsed: coupons.filter((c) => c.status === 'used').length
    };
  },

  'reward-coupons'(ctx) {
    const status = ctx.q.status || '';
    let list = ctx.db.coupons.filter((c) => c.openid === ctx.uid);
    if (status === 'used') list = list.filter((c) => c.status === 'used');
    if (status === 'unused') list = list.filter((c) => c.status !== 'used');
    list.sort((a, b) => b.createTime - a.createTime);
    return {
      ok: true,
      list: list.map((c) => ({
        _id: c._id, code: c.code, status: c.status === 'used' ? 'used' : 'unused',
        cost: c.cost || COUPON_COST, createTime: c.createTime, usedTime: c.usedTime || 0
      }))
    };
  },

  'reward-exchange'(ctx) {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayCount = ctx.db.coupons.filter((c) => c.openid === ctx.uid && c.createTime >= todayStart.getTime()).length;
    if (todayCount >= DAILY_EXCHANGE_LIMIT) {
      return { ok: false, errMsg: '今天已兑换 ' + DAILY_EXCHANGE_LIMIT + ' 张，明天再来' };
    }
    const u = upsertUser(ctx.db, ctx.uid);
    if ((Number(u.points) || 0) < COUPON_COST) {
      return { ok: false, errMsg: '积分不足，满 ' + COUPON_COST + ' 分才能兑换（每成功归还 1 次得 1 分）' };
    }
    u.points -= COUPON_COST;
    const code = genCode();
    const coupon = { _id: genId('cp'), openid: ctx.uid, code, status: 'unused', cost: COUPON_COST, createTime: now, usedTime: 0, usedBy: '' };
    ctx.db.coupons.push(coupon);
    return { ok: true, couponId: coupon._id, code, points: u.points, tip: '到食堂出示核销码即可领取餐券' };
  },

  'reward-verify'(ctx) {
    const code = String(ctx.q.code || '').trim().toUpperCase();
    if (!code) return { ok: false, errMsg: '请输入核销码' };
    const coupon = ctx.db.coupons.find((c) => c.code === code);
    if (!coupon) return { ok: false, errMsg: '核销码不存在，请检查是否输入错误' };
    if (coupon.status === 'used') return { ok: false, errMsg: '该券已于 ' + fmtTime(coupon.usedTime) + ' 核销过' };
    coupon.status = 'used';
    coupon.usedTime = Date.now();
    coupon.usedBy = ctx.uid;
    return { ok: true, coupon: { code: coupon.code, status: 'used', usedTime: coupon.usedTime }, tip: '核销成功，已发放餐券' };
  },

  'reward-grant'(ctx) {
    const delta = Math.min(Math.max(Number(ctx.q.points) || 0, 1), 10);
    const u = upsertUser(ctx.db, ctx.uid);
    u.points = (Number(u.points) || 0) + delta;
    return { ok: true, points: u.points, canExchange: Math.floor(u.points / COUPON_COST), tip: '这是演示用的手动加分，真实加分发生在「认领被同意」时' };
  },

  // ---------- 演示数据 ----------
  seed(ctx) {
    const uid = ctx.uid;
    const now = Date.now();
    // 已有数据则不重复灌
    if (ctx.db.posts.some((p) => p.demo)) return { ok: true, seeded: false, tip: '演示数据已存在' };

    const mk = (userId, type, category, color, brand, campus, building, daysAgo, description, extraLocations, idNumber) => {
      const locations = [{ campus, building }].concat(extraLocations || []);
      const post = {
        _id: genId('p'), type, category, color, brand, campus, building, locations,
        eventTime: now - daysAgo * DAY, timeUnknown: false,
        description, images: [], contact: { wechat: 'demo_wx_' + category, phone: '' },
        status: 'active', userId, demo: true, createTime: now - daysAgo * DAY, updateTime: now - daysAgo * DAY
      };
      if (idNumber) { post.sensitive = { idNumber }; post.idTail = '****' + String(idNumber).slice(-4); }
      ctx.db.posts.push(post);
      return post;
    };

    const demoUsers = ['demo_alice', 'demo_bob', 'demo_carol', 'demo_dave', 'demo_eve'];
    // 前 3 条归当前用户
    mk(uid, 'lost', '校园卡/一卡通', '蓝色', '', '将军路校区', '图书馆', 1, '蓝色卡套的校园卡，卡面贴了一张柯基贴纸，在图书馆三楼靠窗位置丢失', [], 'S01234567');
    mk(uid, 'found', '水杯', '白色', '膳魔师', '将军路校区', '计算中心', 2, '白色膳魔师保温杯，杯身有划痕，在计算中心机房捡到');
    mk(uid, 'lost', '耳机', '白色', 'AirPods', '明故宫校区', '图书馆', 3, '白色 AirPods 耳机盒，盒子右下角有磨损');
    // 其余为虚拟用户，发布新帖时可被匹配
    mk('demo_alice', 'found', '校园卡/一卡通', '蓝色', '', '将军路校区', '图书馆', 1, '在图书馆三楼捡到一张校园卡，蓝色卡套，卡面有柯基贴纸', [], 'S01234567');
    mk('demo_bob', 'found', '耳机', '白色', 'AirPods', '明故宫校区', '荟萃楼', 2, '荟萃楼自习室捡到 AirPods，白色盒子');
    mk('demo_carol', 'lost', '手机', '黑色', 'iPhone 13', '将军路校区', '一食堂', 1, '黑色 iPhone 13，黑色磨砂壳，壳背面有个月球贴纸');
    mk('demo_dave', 'found', '钥匙', '银色', '', '将军路校区', '慧园足球场', 4, '一串银色钥匙，挂着一个皮卡丘挂件');
    mk('demo_eve', 'found', '雨伞', '黑色', '', '天目湖校区', '教学楼', 5, '黑色长柄雨伞，伞柄有弯钩，落在教学楼楼梯口');

    // 预置：一条匹配提醒 + 一条待处理认领申请 + 积分与餐券
    const demoPost = ctx.db.posts.find((p) => p._id !== ctx.db.posts[0]._id && p.userId === 'demo_alice');
    pushMessage(ctx.db, {
      toUserId: uid, type: 'match',
      postId: ctx.db.posts[0]._id, matchPostId: demoPost._id, fromUserId: 'demo_alice',
      score: 88, reasons: ['同类别：校园卡/一卡通', '同地点：将军路校区·图书馆', '证件号后四位一致']
    });
    const claim = {
      _id: genId('c'), postId: ctx.db.posts[1]._id, ownerId: uid, claimerId: 'demo_bob',
      postType: 'found', postCategory: '水杯',
      message: '白色膳魔师保温杯是我的，杯底贴了我的姓名贴',
      claimerContact: { wechat: 'demo_bob_wx', phone: '' },
      status: 'pending', createTime: now - 3600 * 1000
    };
    ctx.db.claims.push(claim);
    pushMessage(ctx.db, {
      toUserId: uid, type: 'claim', claimId: claim._id, postId: ctx.db.posts[1]._id,
      score: 0, reasons: ['有人申请认领你的「水杯」'], note: claim.message
    });
    upsertUser(ctx.db, uid, { points: 3 });
    if (!ctx.db.coupons.some((c) => c.openid === uid)) {
      ctx.db.coupons.push({ _id: genId('cp'), openid: uid, code: genCode(), status: 'unused', cost: 2, createTime: now, usedTime: 0, usedBy: '', demo: true });
      ctx.db.coupons.push({ _id: genId('cp'), openid: uid, code: genCode(), status: 'used', cost: 2, createTime: now - 3 * DAY, usedTime: now - 2 * DAY, usedBy: 'demo_canteen', demo: true });
    }
    return { ok: true, seeded: true, tip: '已灌入演示数据' };
  },

  clear(ctx) {
    ctx.db.posts = ctx.db.posts.filter((p) => !p.demo);
    ctx.db.messages = ctx.db.messages.filter((m) => !m.demo);
    ctx.db.coupons = ctx.db.coupons.filter((c) => !c.demo);
    ctx.db.claims = ctx.db.claims.filter((c) => c.ownerId !== 'demo_bob');
    return { ok: true };
  }
};

function pickProfile(u) {
  return { email: u.email || '', notifyEmail: !!u.notifyEmail, phone: u.phone || '', notifySms: !!u.notifySms, points: Number(u.points) || 0 };
}

// ==================== 入口 ====================
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const url = new URL(req.url, 'http://localhost');
    const name = (url.pathname.replace(/^\/api\//, '') || 'login').replace(/\/+$/, '');
    const handler = handlers[name];
    if (!handler) return res.status(404).json({ ok: false, errMsg: '未知接口：' + name });

    // GET 参数 / POST JSON body 合并
    const q = {};
    url.searchParams.forEach((v, k) => { q[k] = v; });
    if (req.method === 'POST') {
      const body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => resolve(raw));
      });
      if (body) {
        try {
          Object.assign(q, JSON.parse(body));
        } catch (e) { /* 忽略非法 JSON */ }
      }
    }

    const uid = String(req.headers['x-user-id'] || q.uid || '').trim();
    if (!uid) return res.status(401).json({ ok: false, errMsg: '缺少用户身份（x-user-id）' });

    // 数值/布尔/对象字段做一次类型还原（query 传的会是字符串）
    ['filters', 'post', 'contact', 'notifyEmail', 'notifySms', 'dryRun', 'points', 'eventTime', 'eventTimeEnd'].forEach((k) => {
      if (typeof q[k] === 'string' && (q[k][0] === '{' || q[k][0] === '[')) {
        try { q[k] = JSON.parse(q[k]); } catch (e) { /* keep */ }
      }
    });

    const db = await loadDB();
    const result = handler({ req, q, uid, db });
    await saveDB(db);
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, errMsg: '服务器错误：' + (e.message || e) });
  }
};
