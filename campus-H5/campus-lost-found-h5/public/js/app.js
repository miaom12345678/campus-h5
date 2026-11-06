/**
 * 校园失物招领 H5 —— 单页应用（hash 路由）
 * 由小程序 6 个页面 + post-card 组件迁移而来：
 *   #/           广场（搜索 + 筛选 + 列表）
 *   #/publish    发布（失物/招领表单 + 发布结果）
 *   #/message    消息中心（匹配提醒 / 认领申请 / 处理结果）
 *   #/mine       我的（积分、我的帖子、申请管理、通知设置）
 *   #/detail     帖子详情（认领 / 结束 / 联系方式解锁）
 *   #/coupon     餐券（积分兑换 / 核销）
 */
import { api, getUid } from './api.js';
import {
  formatDate, formatDateTime, relativeTime, postTitle, statusText, scoreLevel, levelText
} from './util.js';
import {
  CATEGORIES, COLORS, CAMPUS_LOCATIONS, MAX_LOCATION, TIME_MODES, needIdNumber, getGroups
} from './categories.js';

const $ = (sel, root) => (root || document).querySelector(sel);
const host = $('#pageHost');
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- UI 基础 ----------
let toastTimer = null;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = 'none'), 2200);
}

export function modal(title, content, { showCancel = true } = {}) {
  return new Promise((resolve) => {
    $('#modalTitle').textContent = title;
    $('#modalContent').textContent = content;
    $('#modalCancel').classList.toggle('hide', !showCancel);
    $('#modal').style.display = 'flex';
    $('#modalOk').onclick = () => { $('#modal').style.display = 'none'; resolve(true); };
    $('#modalCancel').onclick = () => { $('#modal').style.display = 'none'; resolve(false); };
  });
}

function copyText(v) {
  if (!v) return;
  (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
    .then(() => toast('已复制'))
    .catch(() => {
      const ta = document.createElement('textarea');
      ta.value = v;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    });
}

function previewImg(src) {
  $('#previewImg').src = src;
  $('#previewMask').style.display = 'flex';
  $('#previewMask').onclick = () => ($('#previewMask').style.display = 'none');
}

function locTextOf(post, maxShow) {
  if (!post) return '';
  let locs = (post.locations && post.locations.length) ? post.locations : null;
  if (!locs) locs = post.building ? [{ campus: post.campus, building: post.building }] : [];
  if (!locs.length) return post.campus || '';
  const campus = locs[0].campus || post.campus || '';
  const names = locs.map((l) => l.building).filter(Boolean);
  if (!names.length) return campus;
  const shown = names.slice(0, maxShow || 2).join(maxShow ? '、' : '/');
  const tail = names.length > (maxShow || 2) ? ' 等' + names.length + '处' : '';
  return campus + '·' + shown + tail;
}

function eventTextOf(post) {
  if (!post) return '';
  if (post.timeUnknown) return '记不清了（时间不参与匹配）';
  const start = formatDate(post.eventTime);
  if (post.eventTimeEnd && post.eventTimeEnd > post.eventTime) {
    return start + ' 至 ' + formatDate(post.eventTimeEnd) + '（' + relativeTime(post.eventTime) + '）';
  }
  return start + '（' + relativeTime(post.eventTime) + '）';
}

// ---------- 导航 / TabBar ----------
const TAB_TITLES = { square: '校园失物招领', publish: '发布信息', message: '消息中心', mine: '我的', detail: '详情', coupon: '我的餐券' };

function setNav(page) {
  $('#navTitle').textContent = TAB_TITLES[page] || '校园失物招领';
  $('#navBack').style.display = page === 'detail' || page === 'coupon' ? 'block' : 'none';
  $('#navBack').onclick = () => history.back();
  const isTab = ['square', 'publish', 'message', 'mine'].indexOf(page) >= 0;
  $('#tabbar').style.display = isTab ? 'flex' : 'none';
  document.querySelectorAll('.tab-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.tab === page);
  });
}

export async function refreshBadge() {
  try {
    const r = await api.unreadCount();
    const n = (r && r.count) || 0;
    [$('#badgeMsg'), $('#badgeMsg2')].forEach((b) => {
      b.style.display = n > 0 ? 'block' : 'none';
      b.textContent = n > 99 ? '99+' : n;
    });
  } catch (e) { /* ignore */ }
}

// ---------- 帖子卡片（原 post-card 组件） ----------
function postCard(post, showScore) {
  const title = postTitle(post);
  const time = relativeTime(post.eventTime || post.createTime);
  const cover = post.images && post.images.length ? post.images[0] : '';
  const lv = scoreLevel(post.matchScore || 0);
  const reasons = (post.matchReasons || [])
    .map((r) => `<span class="pc-reason">${esc(r)}</span>`).join('');
  return `
  <div class="pc" data-id="${esc(post._id)}">
    ${cover ? `<img class="pc-cover" src="${esc(cover)}" onerror="this.style.display='none'" />` : ''}
    <div class="pc-body">
      <div class="pc-row1">
        <span class="tag ${post.type === 'lost' ? 'tag-lost' : 'tag-found'}">${post.type === 'lost' ? '失物' : '招领'}</span>
        <span class="pc-title">${esc(title)}</span>
        ${post.status !== 'active' ? `<span class="pc-status">${esc(statusText(post.status))}</span>` : ''}
      </div>
      <div class="pc-desc clamp-2">${esc(post.description || '（无描述）')}</div>
      ${reasons ? `<div class="pc-reasons">${reasons}</div>` : ''}
      ${showScore && post.matchScore > 0 ? `
      <div class="pc-badges">
        ${levelText(post.matchScore) ? `<span class="pc-badge ${lv}">${levelText(post.matchScore)}</span>` : ''}
        <span class="pc-score ${lv}">${post.matchScore} 分</span>
      </div>` : ''}
      <div class="pc-meta">
        <span class="pc-loc">${esc(locTextOf(post))}</span>
        <span class="pc-time">${esc(time)}</span>
      </div>
    </div>
  </div>`;
}

// ==================== 页面：广场 ====================
async function pageSquare() {
  const state = {
    tabIndex: 0,
    keyword: '',
    categoryIndex: 0,
    colorIndex: 0,
    campusIndex: 0,
    buildingIndex: 0,
    page: 1, hasMore: false, loading: false, loaded: false, total: 0, list: []
  };
  const tabs = [{ key: 'all', label: '全部' }, { key: 'lost', label: '失物帖' }, { key: 'found', label: '招领帖' }];

  host.innerHTML = `<div class="page" id="sq"></div>`;
  const root = $('#sq');

  const buildingOptions = () => {
    const list = state.campusIndex > 0 ? CAMPUS_LOCATIONS[state.campusIndex - 1].groups.flatMap((g) => g.buildings) : [];
    return ['全部位置'].concat(list);
  };

  const opt = (list, sel, name) =>
    `<select data-name="${name}">${list.map((x, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>`;

  function render() {
    const bo = buildingOptions();
    root.innerHTML = `
      <div class="search-bar">
        <div class="search-input">
          <span>🔍</span>
          <input class="search-field" id="sqKw" placeholder="搜索物品特征，如「黑色 校园卡 张三」" value="${esc(state.keyword)}" />
          <span class="search-btn" id="sqSearch">搜索</span>
        </div>
        <div class="tabs">
          ${tabs.map((t, i) => `<span class="tab-pill ${state.tabIndex === i ? 'tab-on' : ''}" data-tab="${i}">${t.label}</span>`).join('')}
        </div>
        <div class="filters">
          ${opt(['全部类别'].concat(CATEGORIES), state.categoryIndex, 'category')}
          ${opt(['全部校区'].concat(CAMPUS_LOCATIONS.map((c) => c.name)), state.campusIndex, 'campus')}
          ${opt(bo, state.buildingIndex, 'building')}
          ${opt(['全部颜色'].concat(COLORS), state.colorIndex, 'color')}
          <span class="filter-reset" id="sqReset">重置</span>
        </div>
      </div>
      ${state.loaded && state.total !== null ? `<div class="result-bar">共 <span class="result-num">${state.total}</span> 条结果，按与你填写条件的匹配度从高到低排序</div>` : ''}
      <div id="sqErr"></div>
      <div id="sqList" class="list"></div>
      <div class="load-more" id="sqMore" style="display:none"></div>
      <div id="sqEmpty"></div>
      <button class="fab" id="sqFab" title="发布">＋</button>`;

    const kw = $('#sqKw');
    kw.onkeydown = (e) => { if (e.key === 'Enter') { state.keyword = kw.value; load(true); } };
    $('#sqSearch').onclick = () => { state.keyword = kw.value; load(true); };
    root.querySelectorAll('.tab-pill').forEach((el) => {
      el.onclick = () => { state.tabIndex = Number(el.dataset.tab); render(); load(true); };
    });
    root.querySelectorAll('select').forEach((sel) => {
      sel.onchange = () => {
        const v = Number(sel.value);
        if (sel.dataset.name === 'category') state.categoryIndex = v;
        if (sel.dataset.name === 'color') state.colorIndex = v;
        if (sel.dataset.name === 'campus') { state.campusIndex = v; state.buildingIndex = 0; }
        if (sel.dataset.name === 'building') state.buildingIndex = v;
        render(); load(true);
      };
    });
    $('#sqReset').onclick = () => {
      Object.assign(state, { tabIndex: 0, keyword: '', categoryIndex: 0, colorIndex: 0, campusIndex: 0, buildingIndex: 0 });
      render(); load(true);
    };
    $('#sqFab').onclick = () => (location.hash = '#/publish');
    $('#sqList').querySelectorAll('.pc').forEach((el) => {
      el.onclick = () => (location.hash = '#/detail?id=' + el.dataset.id);
    });
    renderList();
  }

  function renderList() {
    $('#sqList').innerHTML = state.list.map((p) => postCard(p, false)).join('');
    $('#sqList').querySelectorAll('.pc').forEach((el) => {
      el.onclick = () => (location.hash = '#/detail?id=' + el.dataset.id);
    });
    const more = $('#sqMore');
    if (state.loaded && state.list.length) {
      more.style.display = 'block';
      more.textContent = state.hasMore ? (state.loading ? '加载中…' : '上拉加载更多') : '—— 没有更多了 ——';
      more.onclick = () => { if (state.hasMore && !state.loading) load(false); };
    } else more.style.display = 'none';
    $('#sqEmpty').innerHTML =
      state.loaded && !state.list.length
        ? `<div class="empty"><div class="empty-icon">🔎</div><div class="empty-title">还没有匹配的帖子</div>
           <div class="empty-desc">把你丢失 / 捡到的物品描述发上来，\n系统会持续帮你盯着，有匹配就通知你。</div>
           <button class="btn-primary empty-btn" id="sqGoPub">发布一条信息</button></div>`
        : '';
    const gp = $('#sqGoPub');
    if (gp) gp.onclick = () => (location.hash = '#/publish');
  }

  function buildFilters() {
    const f = { type: tabs[state.tabIndex].key };
    if (state.categoryIndex > 0) f.category = CATEGORIES[state.categoryIndex - 1];
    if (state.colorIndex > 0) f.color = COLORS[state.colorIndex - 1];
    if (state.campusIndex > 0) f.campus = CAMPUS_LOCATIONS[state.campusIndex - 1].name;
    if (state.buildingIndex > 0) f.buildings = [buildingOptions()[state.buildingIndex]];
    if (state.keyword) f.keyword = state.keyword;
    return f;
  }

  async function load(reset) {
    if (state.loading) return;
    const page = reset ? 1 : state.page + 1;
    state.loading = true;
    renderList();
    try {
      const r = await api.search(buildFilters(), page, 20);
      if (!r.ok) {
        $('#sqErr').innerHTML = `<div class="err">⚠️ ${esc(r.errMsg || '搜索失败')}</div>`;
      } else {
        state.list = reset ? r.list : state.list.concat(r.list);
        state.page = page;
        state.total = r.total;
        state.hasMore = !!r.hasMore;
        $('#sqErr').innerHTML = '';
      }
      state.loaded = true;
    } catch (e) {
      $('#sqErr').innerHTML = `<div class="err">⚠️ 加载失败，请稍后重试</div>`;
      state.loaded = true;
    }
    state.loading = false;
    renderList();
  }

  render();
  await load(true);
}

// ==================== 页面：发布 ====================
async function pagePublish(params) {
  const s = {
    type: params.type === 'found' ? 'found' : 'lost',
    categoryIndex: 0,
    colorIndex: 0,
    campusIndex: 0,
    selected: [],
    locationUnknown: false,
    customLocation: '',
    timeMode: 'day',
    eventDate: formatDate(Date.now()),
    eventDateEnd: formatDate(Date.now()),
    showIdField: needIdNumber(CATEGORIES[0]),
    idNumber: '',
    brand: '',
    description: '',
    images: [], // [{src}]
    wechat: '',
    phone: '',
    submitting: false,
    result: null
  };
  const today = formatDate(Date.now());
  const minDate = formatDate(Date.now() - 365 * 24 * 3600 * 1000);

  host.innerHTML = `<div class="page no-tab" id="pb"></div>`;
  const root = $('#pb');

  function render() {
    if (s.result) return renderResult();
    const groups = s.locationUnknown ? [] : getGroups(s.campusIndex);
    root.innerHTML = `
      <div class="type-switch">
        <div class="type-item ${s.type === 'lost' ? 'type-on-lost' : ''}" data-type="lost">
          <span class="type-emoji">😢</span><span class="type-label">我丢了东西</span><span class="type-desc">发布失物信息</span>
        </div>
        <div class="type-item ${s.type === 'found' ? 'type-on-found' : ''}" data-type="found">
          <span class="type-emoji">🎁</span><span class="type-label">我捡到东西</span><span class="type-desc">发布招领信息</span>
        </div>
      </div>
      <div class="tip">${s.type === 'lost' ? '填写得越具体，越容易被捡到的人匹配到。' : '填写得越具体，失主越容易确认是自己的。'}</div>

      <div class="card">
        <div class="card-title">物品信息</div>
        <div class="form-row"><span class="label">类别 <span class="req">*</span></span>
          <select class="picker" id="pbCat">${CATEGORIES.map((c, i) => `<option value="${i}" ${i === s.categoryIndex ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="form-row"><span class="label">颜色</span>
          <select class="picker" id="pbColor">${COLORS.map((c, i) => `<option value="${i}" ${i === s.colorIndex ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="field-hint">选填。身份证、证件这类没有颜色的，保持「不确定/不适用」即可，不会因为颜色对不上而被扣分。</div>
        <div class="form-row"><span class="label">品牌/型号</span>
          <input class="input" id="pbBrand" placeholder="选填，如「小米」「iPhone 13」" value="${esc(s.brand)}" />
        </div>
        ${s.showIdField ? `
        <div class="form-row"><span class="label">证件号码</span>
          <input class="input" id="pbId" placeholder="选填，填完整号码" maxlength="30" value="${esc(s.idNumber)}" />
        </div>
        <div class="privacy-tip">🔒 隐私防护：完整号码<span class="strong">只存在后台用于匹配</span>，别人在帖子上只能看到 <span class="id-mask">${esc(maskId(s.idNumber) || '****后四位')}</span>。填了完整号码，匹配会准很多。</div>` : ''}
        <div class="form-row" style="align-items:flex-start"><span class="label" style="padding-top:9px">特征描述 <span class="req">*</span></span>
          <textarea class="textarea" id="pbDesc" maxlength="300" placeholder="${s.type === 'lost' ? '例：黑色小米充电宝，背面有卡通贴纸，挂着一个蓝色小挂绳' : '例：黑色小米充电宝，在图书馆三楼靠窗位置捡到，背面有贴纸'}">${esc(s.description)}</textarea>
        </div>
        <div class="counter">${s.description.length}/300</div>
      </div>

      <div class="card">
        <div class="card-title">地点与时间</div>
        <div class="form-row"><span class="label">校区 <span class="req">*</span></span>
          <select class="picker" id="pbCampus">${CAMPUS_LOCATIONS.map((c, i) => `<option value="${i}" ${i === s.campusIndex ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        </div>
        <div class="loc-block">
          <div class="loc-head"><span class="loc-label">具体位置</span><span class="loc-count">${s.selected.length}/${MAX_LOCATION}</span></div>
          <div class="field-hint">可多选（最多 ${MAX_LOCATION} 个）。拿不准在哪丢的就多勾几个，系统会逐个比对。</div>
          ${s.selected.length ? `<div class="loc-selected">${s.selected.map((b) => `<span class="loc-tag">${esc(b)}</span>`).join('')}<span class="loc-clear" id="pbClearLoc">清空</span></div>` : ''}
          ${!s.locationUnknown ? groups.map((g) => `
            <div class="loc-group-title">${esc(g.label)}</div>
            <div class="loc-chips">${g.buildings.map((b) =>
              `<span class="loc-chip ${s.selected.indexOf(b) >= 0 ? 'loc-chip-on' : ''}" data-b="${esc(b)}">${esc(b)}</span>`).join('')}</div>`).join('') : ''}
          <div class="loc-extra">
            <span class="loc-chip ${s.locationUnknown ? 'loc-chip-on' : ''}" id="pbUnknown">记不清具体在哪</span>
            <span class="loc-extra-tip">勾选后只按校区匹配，地点不会扣分</span>
          </div>
          <div class="loc-custom">
            <input class="loc-input" id="pbCustom" maxlength="20" placeholder="选项里没有？自己填一个，如「体育馆二楼看台」" value="${esc(s.customLocation)}" />
          </div>
        </div>
        <div class="time-block">
          <div class="loc-head"><span class="loc-label">${s.type === 'lost' ? '丢失时间' : '捡到时间'}</span></div>
          <div class="time-modes">
            ${TIME_MODES.map((m) => `<span class="time-mode ${s.timeMode === m.key ? 'time-mode-on' : ''}" data-mode="${m.key}">${m.label}</span>`).join('')}
          </div>
          ${s.timeMode === 'day' ? `
          <div class="form-row"><span class="label">日期</span>
            <input type="date" class="input" id="pbDate" value="${s.eventDate}" min="${minDate}" max="${today}" />
          </div>` : ''}
          ${s.timeMode === 'range' ? `
          <div class="form-row"><span class="label">开始日期</span>
            <input type="date" class="input" id="pbDate" value="${s.eventDate}" min="${minDate}" max="${today}" />
          </div>
          <div class="form-row"><span class="label">结束日期</span>
            <input type="date" class="input" id="pbDateEnd" value="${s.eventDateEnd}" min="${s.eventDate}" max="${today}" />
          </div>
          <div class="field-hint">适合「那几天记不清是哪天」的情况，对方只要是在这个区间内捡到的都算时间吻合。</div>` : ''}
          ${s.timeMode === 'unknown' ? `<div class="field-hint">已选择「记不清了」：时间不参与打分，也不会因为对不上而被扣分。</div>` : ''}
          ${s.timeMode !== 'unknown' ? `
          <div class="chips">
            <span class="chip" data-days="0">今天</span><span class="chip" data-days="1">昨天</span>
            <span class="chip" data-days="3">近三天</span><span class="chip" data-days="7">近一周</span>
            <span class="chip" data-days="30">近一个月</span>
          </div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-title">物品照片（选填，最多 3 张）</div>
        <div class="imgs" id="pbImgs">
          ${s.images.map((im, i) => `
            <div class="img-wrap">
              <img class="img" src="${im.src}" data-i="${i}" />
              <span class="img-del" data-i="${i}">×</span>
            </div>`).join('')}
          ${s.images.length < 3 ? `<div class="img-add" id="pbAddImg"><span class="img-add-plus">＋</span><span>添加照片</span></div>` : ''}
        </div>
        <input type="file" id="pbFile" accept="image/*" multiple style="display:none" />
        <div class="hint" style="margin-top:8px">提示：证件类（校园卡、身份证）建议对关键信息打码后再上传，避免被冒领。</div>
      </div>

      <div class="card">
        <div class="card-title">联系方式</div>
        <div class="privacy-tip">🔒 仅在你与对方互相确认匹配后才会展示给对方，广场列表里不会公开。</div>
        <div class="form-row"><span class="label">微信号</span><input class="input" id="pbWx" placeholder="选填" value="${esc(s.wechat)}" /></div>
        <div class="form-row"><span class="label">手机号</span><input class="input" id="pbPhone" type="tel" placeholder="选填" value="${esc(s.phone)}" /></div>
        <div class="hint">微信号与手机号至少填写一项。</div>
      </div>

      <button class="btn-primary submit-btn ${s.submitting ? 'disabled' : ''}" id="pbSubmit">${s.submitting ? '发布中…' : '发布并开始匹配'}</button>
      <div class="submit-tip">发布后系统会立刻与${s.type === 'lost' ? '招领' : '失物'}帖比对，有新匹配会推送到「消息」。</div>`;

    // 事件绑定
    root.querySelectorAll('.type-item').forEach((el) => {
      el.onclick = () => { s.type = el.dataset.type; render(); };
    });
    $('#pbCat').onchange = (e) => {
      s.categoryIndex = Number(e.target.value);
      s.showIdField = needIdNumber(CATEGORIES[s.categoryIndex]);
      if (!s.showIdField) s.idNumber = '';
      render();
    };
    $('#pbColor').onchange = (e) => (s.colorIndex = Number(e.target.value));
    $('#pbBrand').oninput = (e) => (s.brand = e.target.value);
    const idEl = $('#pbId');
    if (idEl) idEl.oninput = (e) => (s.idNumber = e.target.value);
    $('#pbDesc').oninput = (e) => { s.description = e.target.value; e.target.parentElement.nextElementSibling.textContent = s.description.length + '/300'; };
    $('#pbCampus').onchange = (e) => { s.campusIndex = Number(e.target.value); s.selected = []; render(); };
    root.querySelectorAll('.loc-chip[data-b]').forEach((el) => {
      el.onclick = () => {
        const b = el.dataset.b;
        const i = s.selected.indexOf(b);
        if (i >= 0) s.selected.splice(i, 1);
        else {
          if (s.selected.length >= MAX_LOCATION) return toast('最多选 ' + MAX_LOCATION + ' 个地点');
          s.selected.push(b);
        }
        render();
      };
    });
    const cl = $('#pbClearLoc');
    if (cl) cl.onclick = () => { s.selected = []; render(); };
    $('#pbUnknown').onclick = () => { s.locationUnknown = !s.locationUnknown; if (s.locationUnknown) s.selected = []; render(); };
    $('#pbCustom').oninput = (e) => (s.customLocation = e.target.value);
    root.querySelectorAll('.time-mode').forEach((el) => {
      el.onclick = () => { s.timeMode = el.dataset.mode; render(); };
    });
    const d1 = $('#pbDate');
    if (d1) d1.onchange = (e) => (s.eventDate = e.target.value);
    const d2 = $('#pbDateEnd');
    if (d2) d2.onchange = (e) => (s.eventDateEnd = e.target.value);
    root.querySelectorAll('.chip[data-days]').forEach((el) => {
      el.onclick = () => {
        const days = Number(el.dataset.days);
        s.eventDate = formatDate(Date.now() - days * 86400000);
        if (s.timeMode === 'range') s.eventDateEnd = days > 0 ? today : s.eventDate;
        render();
      };
    });
    const addImg = $('#pbAddImg');
    if (addImg) addImg.onclick = () => $('#pbFile').click();
    $('#pbFile').onchange = (e) => {
      const files = Array.from(e.target.files || []).slice(0, 3 - s.images.length);
      files.forEach((f) => compressImage(f, (src) => { s.images.push({ src }); render(); }));
      e.target.value = '';
    };
    root.querySelectorAll('.img-del').forEach((el) => {
      el.onclick = () => { s.images.splice(Number(el.dataset.i), 1); render(); };
    });
    root.querySelectorAll('#pbImgs .img').forEach((el) => (el.onclick = () => previewImg(el.src)));
    $('#pbWx').oninput = (e) => (s.wechat = e.target.value);
    $('#pbPhone').oninput = (e) => (s.phone = e.target.value);
    $('#pbSubmit').onclick = submit;
  }

  function maskId(raw) {
    const t = String(raw || '').replace(/\s|-/g, '');
    if (!t) return '';
    return t.length <= 4 ? t : '****' + t.slice(-4);
  }

  function compressImage(file, cb) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 640;
        let w = img.width, h = img.height;
        if (w > max || h > max) {
          const r = Math.min(max / w, max / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        cb(c.toDataURL('image/jpeg', 0.7));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    if (s.submitting) return;
    if (!s.description.trim() && !s.brand.trim() && !s.idNumber.trim()) return toast('请填写物品特征描述');
    if (s.description.trim() && s.description.trim().length < 5 && !s.idNumber.trim()) return toast('描述太短了，至少 5 个字');
    if (!s.wechat.trim() && !s.phone.trim()) return toast('请至少留一种联系方式');
    const custom = s.customLocation.trim();
    if (!s.locationUnknown && !s.selected.length && !custom) return toast('请选择地点，或勾选「记不清在哪」');

    let eventTime = 0, eventTimeEnd = 0;
    const timeUnknown = s.timeMode === 'unknown';
    if (!timeUnknown) {
      eventTime = new Date(s.eventDate.replace(/-/g, '/') + ' 12:00:00').getTime();
      if (s.timeMode === 'range') {
        if (!s.eventDateEnd) return toast('请选择时间段的结束日期');
        eventTimeEnd = new Date(s.eventDateEnd.replace(/-/g, '/') + ' 12:00:00').getTime();
        if (eventTimeEnd < eventTime) return toast('结束日期要晚于开始日期');
      }
    } else {
      eventTime = new Date(today.replace(/-/g, '/') + ' 12:00:00').getTime();
    }

    const campus = CAMPUS_LOCATIONS[s.campusIndex].name;
    let locations = s.selected.map((b) => ({ campus, building: b }));
    if (custom && locations.length < MAX_LOCATION) locations.push({ campus, building: custom });
    if (s.locationUnknown || !locations.length) locations = [{ campus, building: '' }];

    const post = {
      type: s.type,
      category: CATEGORIES[s.categoryIndex],
      color: COLORS[s.colorIndex],
      brand: s.brand.trim(),
      campus,
      building: locations[0].building,
      locations,
      locationUnknown: s.locationUnknown,
      eventTime,
      eventTimeEnd,
      timeUnknown,
      description: s.description.trim(),
      images: s.images.map((i) => i.src),
      contact: { wechat: s.wechat.trim(), phone: s.phone.trim() }
    };
    if (s.showIdField && s.idNumber.trim()) {
      post.sensitive = { idNumber: s.idNumber.trim() };
      post.idTail = maskId(s.idNumber);
    }

    s.submitting = true;
    render();
    const r = await api.publish(post);
    s.submitting = false;
    if (!r.ok) {
      render();
      return modal('发布失败', r.errMsg || '请稍后重试', { showCancel: false });
    }
    s.result = r;
    refreshBadge();
    render();
  }

  function renderResult() {
    const r = s.result;
    root.innerHTML = `
      <div class="result">
        <div class="result-icon">✅</div>
        <div class="result-title">发布成功</div>
        ${r.matchCount > 0 ? `
        <div class="card result-card">
          <div class="result-hit">为你找到 <span class="result-num">${r.matchCount}</span> 条可能匹配的帖子</div>
          <div class="result-sub">已推送到对方的「消息」中心，对方确认后会联系你。</div>
          ${r.highCount > 0 ? `<div class="result-high">其中 <span class="result-high-num">${r.highCount}</span> 条「高度匹配」，全部列给你，挑最像的联系。</div>` : ''}
          ${(r.topMatches || []).map((m) => `
            <div class="match-item" data-id="${esc(m.postId)}">
              <div class="match-head">
                <span class="tag ${m.summary.type === 'lost' ? 'tag-lost' : 'tag-found'}">${m.summary.type === 'lost' ? '失物' : '招领'}</span>
                <span class="match-cat">${esc(m.summary.category)}</span>
                <span class="match-score ${m.level}">匹配度 ${m.score}</span>
              </div>
              ${m.levelText ? `<div class="match-level ${m.level}">${esc(m.levelText)}</div>` : ''}
              <div class="match-desc clamp-2">${esc(m.summary.description)}</div>
              <div class="match-loc">${esc(m.summary.campus)}${(m.summary.locations || []).map((l) => `<span class="loc-mini">· ${esc(l.building)}</span>`).join('')}</div>
            </div>`).join('')}
        </div>` : `
        <div class="card result-card">
          <div class="result-hit">暂时没有匹配到相似的帖子</div>
          <div class="result-sub">别担心，帖子已经挂上了。之后只要有${s.type === 'lost' ? '招领' : '失物'}帖与你吻合，系统会第一时间推送给你，不用反复来搜。</div>
        </div>`}
        <button class="btn-primary" id="rGoMsg">去消息中心看看</button>
        <button class="btn-plain btn-gap" id="rGoHome">返回广场</button>
        <div class="link-again" id="rAgain">再发一条</div>
      </div>`;
    root.querySelectorAll('.match-item').forEach((el) => {
      el.onclick = () => (location.hash = '#/detail?id=' + el.dataset.id);
    });
    $('#rGoMsg').onclick = () => (location.hash = '#/message');
    $('#rGoHome').onclick = () => (location.hash = '#/');
    $('#rAgain').onclick = () => {
      s.result = null;
      s.description = ''; s.brand = ''; s.images = []; s.idNumber = '';
      s.customLocation = ''; s.locationUnknown = false; s.selected = [];
      render();
      window.scrollTo(0, 0);
    };
  }

  render();
}

// ==================== 页面：消息 ====================
async function pageMessage() {
  host.innerHTML = `<div class="page" id="msg"><div class="loading">加载中…</div></div>`;
  const root = $('#msg');
  let list = [], unread = 0, highUnread = 0, loaded = false;

  function render() {
    root.innerHTML = `
      ${loaded && list.length ? `
      <div class="msg-head">
        <span>共 ${list.length} 条，未读 ${unread} 条</span>
        ${unread ? '<span class="msg-readall" id="mReadAll">全部已读</span>' : ''}
      </div>` : ''}
      ${highUnread ? `<div class="msg-high">有 <span class="msg-high-num">${highUnread}</span> 条「高度匹配」等你确认，建议优先点开看看。</div>` : ''}
      <div class="msg-list">${list.map(msgCard).join('')}</div>
      ${loaded && !list.length ? `
      <div class="empty">
        <div class="empty-icon">🔔</div>
        <div class="empty-title">暂时还没有消息</div>
        <div class="empty-desc">发布一条丢失或捡到的信息后，\n一旦有人发的帖子和你吻合，就会立刻出现在这里。</div>
        <button class="btn-primary empty-btn" id="mGoPub">去发布一条</button>
      </div>` : ''}`;

    const ra = $('#mReadAll');
    if (ra) ra.onclick = async () => {
      await api.readAll();
      toast('已全部标记为已读');
      await load(); refreshBadge();
    };
    const gp = $('#mGoPub');
    if (gp) gp.onclick = () => (location.hash = '#/publish');

    root.querySelectorAll('[data-open]').forEach((el) => {
      el.onclick = () => {
        location.hash = '#/detail?id=' + el.dataset.open +
          (el.dataset.score ? '&score=' + el.dataset.score : '') +
          (el.dataset.reasons ? '&reasons=' + encodeURIComponent(el.dataset.reasons) : '');
      };
    });
    root.querySelectorAll('[data-read]').forEach((el) => {
      el.onclick = async () => {
        await api.readMessage(el.dataset.read);
        await load(); refreshBadge();
      };
    });
    root.querySelectorAll('[data-claim]').forEach((el) => {
      el.onclick = async () => {
        const accept = el.dataset.accept === 'true';
        const ok = await modal(
          accept ? '同意认领？' : '拒绝该申请？',
          accept
            ? '同意后，你的联系方式将对对方可见，帖子标记为已认领；捡到物品的一方 +1 积分。'
            : '拒绝后对方会收到通知，你可以继续等待其他认领。'
        );
        if (!ok) return;
        const r = accept ? await api.claimAccept(el.dataset.claim) : await api.claimReject(el.dataset.claim);
        if (r && r.ok) {
          if (accept && r.credited) toast(r.creditedTo === 'me' ? '已同意，你 +1 积分' : '已同意，对方 +1 积分');
          else toast(accept ? '已同意' : '已拒绝');
        } else toast((r && r.errMsg) || '操作失败');
        await load(); refreshBadge();
      };
    });
  }

  function msgCard(m) {
    const time = relativeTime(m.createTime);
    const lv = scoreLevel(m.score || 0);
    if (m.type === 'claim') {
      return `<div class="msg-card ${m.read ? '' : 'msg-unread'}">
        <div class="msg-top"><span class="msg-type type-claim">认领申请</span><span class="msg-time">${time}</span></div>
        ${m.myPost ? `<div class="msg-line"><span class="msg-k">申请认领</span><span class="msg-v">${esc(postTitle(m.myPost))}</span></div>` : ''}
        ${m.note ? `<div class="msg-note">“${esc(m.note)}”</div>` : ''}
        <div class="msg-actions">
          <span class="msg-btn" data-claim="${esc(m.claimId)}" data-accept="true">同意并解锁联系方式</span>
          <span class="msg-btn plain" data-claim="${esc(m.claimId)}" data-accept="false">不是他</span>
        </div>
      </div>`;
    }
    if (m.type === 'system') {
      return `<div class="msg-card ${m.read ? '' : 'msg-unread'}">
        <div class="msg-top"><span class="msg-type type-system">处理结果</span><span class="msg-time">${time}</span></div>
        <div class="msg-note">${esc((m.reasons || [])[0] || '')}</div>
        <div class="msg-actions">
          ${m.myPost ? `<span class="msg-btn" data-open="${esc(m.myPost._id)}">查看帖子</span>` : ''}
          ${!m.read ? `<span class="msg-btn plain" data-read="${esc(m._id)}">标记已读</span>` : ''}
        </div>
      </div>`;
    }
    return `<div class="msg-card ${m.read ? '' : 'msg-unread'}">
      <div class="msg-top">
        <span class="msg-type type-match">匹配提醒</span>
        ${levelText(m.score) ? `<span class="msg-badge ${lv}">${levelText(m.score)}</span>` : ''}
        <span class="msg-score ${lv}">${m.score} 分</span><span class="msg-time">${time}</span>
      </div>
      ${m.myPost ? `<div class="msg-line"><span class="msg-k">你的帖子</span><span class="msg-v">${esc(postTitle(m.myPost))}</span></div>` : ''}
      ${m.matchPost ? `<div class="msg-line"><span class="msg-k">匹配到</span><span class="msg-v highlight">${esc(postTitle(m.matchPost))}</span></div>` : ''}
      ${m.matchPost ? `<div class="msg-desc clamp-2">${esc(m.matchPost.description)}</div>` : ''}
      ${m.matchPost ? `<div class="msg-loc">${esc(locTextOf(m.matchPost))}</div>` : ''}
      ${(m.reasons || []).length ? `<div class="msg-reasons">${m.reasons.map((r) => `<span class="msg-reason">${esc(r)}</span>`).join('')}</div>` : ''}
      <div class="msg-actions">
        ${m.matchPost ? `<span class="msg-btn" data-open="${esc(m.matchPost._id)}" data-score="${m.score}" data-reasons="${esc(JSON.stringify(m.reasons || []))}">看看是不是它</span>` : ''}
        ${!m.read ? `<span class="msg-btn plain" data-read="${esc(m._id)}">标记已读</span>` : ''}
      </div>
    </div>`;
  }

  async function load() {
    try {
      const r = await api.messages();
      if (r.ok) {
        list = r.list || [];
        unread = list.filter((m) => !m.read).length;
        highUnread = list.filter((m) => m.type === 'match' && !m.read && m.score >= 85).length;
      }
    } catch (e) { /* ignore */ }
    loaded = true;
    refreshBadge();
    render();
  }

  render();
  await load();
}

// ==================== 页面：详情 ====================
async function pageDetail(params) {
  host.innerHTML = `<div class="page no-tab" id="dt"><div class="loading">加载中…</div></div>`;
  const root = $('#dt');
  let s = { loading: true, post: null, errMsg: '', matchScore: 0, matchReasons: [], claimStatus: '', contactVisible: false, contact: null, showClaimForm: false, claimNote: '', claimWechat: '', claimPhone: '', submitting: false };

  try {
    const saved = JSON.parse(localStorage.getItem('myContact') || '{}');
    s.claimWechat = saved.wechat || '';
    s.claimPhone = saved.phone || '';
  } catch (e) { /* ignore */ }
  s.matchScore = Number(params.score) || 0;
  try { s.matchReasons = JSON.parse(params.reasons || '[]'); } catch (e) { s.matchReasons = []; }

  await load();

  async function load() {
    if (!params.id) { s.loading = false; s.errMsg = '缺少帖子 ID'; return render(); }
    const r = await api.postDetail(params.id);
    s.loading = false;
    if (!r.ok) s.errMsg = r.errMsg || '加载失败';
    else {
      s.post = r.post; s.isMine = r.isMine; s.contactVisible = r.contactVisible;
      s.contact = r.contact; s.claimStatus = r.claimStatus || '';
      api.readByPost(params.id).then(refreshBadge);
    }
    render();
  }

  function render() {
    if (s.loading) return;
    if (s.errMsg || !s.post) {
      root.innerHTML = `<div class="empty"><div class="empty-icon">📭</div><div>${esc(s.errMsg || '加载失败')}</div></div>`;
      return;
    }
    const p = s.post;
    const lv = scoreLevel(s.matchScore);
    root.innerHTML = `
      <div class="head">
        <div class="head-tags">
          <span class="tag ${p.type === 'lost' ? 'tag-lost' : 'tag-found'} big">${p.type === 'lost' ? '失物帖' : '招领帖'}</span>
          <span class="tag ${p.status === 'active' ? 'tag-active' : 'tag-plain'} big">${esc(statusText(p.status))}</span>
        </div>
        <div class="head-title">${p.type === 'lost' ? '丢失' : '捡到'}：${esc(p.category)}</div>
        <div class="head-meta">${esc(locTextOf(p, 9))} · ${esc(eventTextOf(p))}</div>
      </div>

      ${s.matchScore > 0 ? `
      <div class="card match-card">
        <div class="match-head">
          <span class="match-title">系统匹配度</span>
          ${levelText(s.matchScore) ? `<span class="match-badge ${lv}">${levelText(s.matchScore)}</span>` : ''}
          <span class="match-score ${lv}">${s.matchScore}</span>
        </div>
        ${s.matchReasons.length ? `<div class="match-reasons">${s.matchReasons.map((r) => `<span class="reason">${esc(r)}</span>`).join('')}</div>` : ''}
      </div>` : ''}

      ${p.images && p.images.length ? `
      <div class="card"><div class="card-title">物品照片</div>
        <div class="imgs">${p.images.map((im) => `<img class="img" src="${esc(im)}" />`).join('')}</div>
      </div>` : ''}

      <div class="card">
        <div class="card-title">物品细节</div>
        <div class="info-row"><span class="info-k">类别</span><span class="info-v">${esc(p.category)}</span></div>
        <div class="info-row"><span class="info-k">颜色</span><span class="info-v">${esc(p.color || '未填写')}</span></div>
        ${p.brand ? `<div class="info-row"><span class="info-k">品牌/型号</span><span class="info-v">${esc(p.brand)}</span></div>` : ''}
        ${p.idTail ? `<div class="info-row"><span class="info-k">证件号</span><span class="info-v id-tail">${esc(p.idTail)}</span></div>
        <div class="info-row"><span class="info-k"></span><span class="info-v id-note">🔒 完整号码不公开，系统用它做精确匹配，双方确认后由发布者自行告知</span></div>` : ''}
        <div class="info-row"><span class="info-k">地点</span><span class="info-v">${esc(locTextOf(p, 9))}</span></div>
        <div class="info-row"><span class="info-k">${p.type === 'lost' ? '丢失时间' : '捡到时间'}</span><span class="info-v">${esc(eventTextOf(p))}</span></div>
        <div class="info-row"><span class="info-k">发布时间</span><span class="info-v">${esc(relativeTime(p.createTime))}</span></div>
        <div class="desc-block"><span class="info-k">特征描述</span>
          <div class="desc-text">${esc(p.description || '（无）')}</div>
        </div>
      </div>

      ${s.contactVisible ? `
      <div class="card">
        <div class="card-title">🔓 联系方式</div>
        <div class="privacy-tip">双方已确认匹配，以下信息仅你可见，请尽快联系并当面核对物品。</div>
        ${s.contact && s.contact.wechat ? `<div class="info-row"><span class="info-k">微信号</span><span class="info-v copy" data-copy="${esc(s.contact.wechat)}">${esc(s.contact.wechat)}（点击复制）</span></div>` : ''}
        ${s.contact && s.contact.phone ? `<div class="info-row"><span class="info-k">手机号</span><span class="info-v copy" data-copy="${esc(s.contact.phone)}">${esc(s.contact.phone)}（点击复制）</span></div>` : ''}
        ${(!s.contact || (!s.contact.wechat && !s.contact.phone)) ? `<div class="info-row"><span class="info-v">对方未留下联系方式</span></div>` : ''}
      </div>` : ''}

      ${s.showClaimForm ? `
      <div class="card">
        <div class="card-title">申请认领</div>
        <div class="note-tip">说明一下能证明物品是你的细节（如卡号后四位、划痕位置等），方便对方确认。</div>
        <textarea class="textarea" id="dtNote" maxlength="200" placeholder="例：我的卡背面贴了一张柯基贴纸，卡套是蓝色的">${esc(s.claimNote)}</textarea>
        <div class="claim-contact-title">留个联系方式（对方同意后才对他可见）</div>
        <div class="form-row"><span class="label">微信号</span><input class="input" id="dtWx" placeholder="选填" value="${esc(s.claimWechat)}" /></div>
        <div class="form-row"><span class="label">手机号</span><input class="input" id="dtPhone" type="tel" placeholder="选填" value="${esc(s.claimPhone)}" /></div>
        <div class="form-btns">
          <button class="btn-plain btn-half" id="dtCancel">取消</button>
          <button class="btn-primary btn-half" id="dtOk">${s.submitting ? '提交中…' : '提交申请'}</button>
        </div>
      </div>` : ''}

      <div class="bottom-space"></div>
      <div class="action-bar">
        ${s.isMine ? `<span class="action-tip">这是你发布的帖子</span>
          ${p.status === 'active' ? '<button class="btn-plain action-btn" id="dtClose">结束信息</button>' : ''}`
        : p.status !== 'active' ? `<span class="action-tip">该信息已结束</span>`
        : s.claimStatus === 'pending' ? `<span class="action-tip">已申请认领，等待对方确认</span>`
        : s.contactVisible ? `<span class="action-tip">已解锁联系方式，快去联系对方</span>`
        : `<button class="btn-primary action-btn" id="dtClaim">这是我的，申请认领</button>`}
      </div>`;

    root.querySelectorAll('#dtImgs .img, .card .img').forEach((el) => (el.onclick = () => previewImg(el.src)));
    root.querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => copyText(el.dataset.copy)));

    const claimBtn = $('#dtClaim');
    if (claimBtn) claimBtn.onclick = () => { s.showClaimForm = true; render(); };
    const cancelBtn = $('#dtCancel');
    if (cancelBtn) cancelBtn.onclick = () => { s.showClaimForm = false; s.claimNote = ''; render(); };
    const okBtn = $('#dtOk');
    if (okBtn) {
      $('#dtNote').oninput = (e) => (s.claimNote = e.target.value);
      $('#dtWx').oninput = (e) => (s.claimWechat = e.target.value);
      $('#dtPhone').oninput = (e) => (s.claimPhone = e.target.value);
      okBtn.onclick = async () => {
        if (s.submitting) return;
        const note = s.claimNote.trim();
        if (note.length < 5) return toast('请简单说明一下（至少 5 个字）');
        const wechat = s.claimWechat.trim(), phone = s.claimPhone.trim();
        if (!wechat && !phone) return toast('请留一种联系方式');
        s.submitting = true; render();
        const r = await api.claimCreate(params.id, note, { wechat, phone });
        s.submitting = false;
        if (!r.ok) { render(); return toast(r.errMsg || '提交失败'); }
        localStorage.setItem('myContact', JSON.stringify({ wechat, phone }));
        s.showClaimForm = false; s.claimNote = ''; s.claimStatus = 'pending';
        render();
        modal('申请已送出', '对方确认是本人后会解锁联系方式，结果会推送到「消息」。', { showCancel: false });
      };
    }
    const closeBtn = $('#dtClose');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        const isFound = p.type === 'found';
        const ok = await modal('结束这条信息？', isFound
          ? '确认后帖子不再出现在搜索结果中，也不会再参与匹配。\n（招领帖结束将获得 1 积分）'
          : '确认后帖子不再出现在搜索结果中，也不会再参与匹配。');
        if (!ok) return;
        const r = await api.closePost(params.id);
        if (!r.ok) return toast(r.errMsg || '操作失败');
        toast(r.credited ? '已结束，+1 积分' : '已结束');
        refreshBadge();
        await load();
      };
    }
  }
}

// ==================== 页面：我的 ====================
async function pageMine() {
  host.innerHTML = `<div class="page" id="mn"><div class="loading">加载中…</div></div>`;
  const root = $('#mn');
  const s = { tabIndex: 0, myPosts: [], incoming: [], outgoing: [], profile: { email: '', notifyEmail: false, phone: '', notifySms: false }, reward: { points: 0, couponCost: 2, canExchange: 0, couponUnused: 0, couponUsed: 0, returnCount: 0 }, loaded: false };

  const CLAIM_STATUS = { pending: '待处理', accepted: '已同意', rejected: '已拒绝' };

  async function load() {
    const [postsRes, inRes, outRes, profRes, rewardRes] = await Promise.all([
      api.myPosts(), api.incoming(), api.outgoing(), api.getProfile(), api.rewardSummary()
    ]);
    s.myPosts = (postsRes.ok && postsRes.list) || [];
    s.incoming = (inRes.ok && inRes.list) || [];
    s.outgoing = (outRes.ok && outRes.list) || [];
    if (profRes.ok && profRes.profile) s.profile = profRes.profile;
    if (rewardRes.ok) s.reward = Object.assign({}, s.reward, rewardRes);
    s.loaded = true;
    render();
  }

  function render() {
    const r = s.reward;
    root.innerHTML = `
      <div class="card reward-card">
        <div class="rw-top">
          <div class="rw-left">
            <div class="rw-num">${r.points}<span class="rw-unit">分</span></div>
            <div class="rw-sub">已成功归还 ${r.returnCount} 次</div>
          </div>
          <div class="rw-right">
            <div class="rw-coupon">餐券 ${r.couponUnused} 张未使用</div>
            ${r.couponUsed ? '<div class="rw-coupon gray">已核销 ' + r.couponUsed + ' 张</div>' : ''}
          </div>
        </div>
        <div class="rw-rule">每归还 1 次 +1 分，满 ${r.couponCost} 分可换 1 张食堂餐券。</div>
        <div class="rw-progress">
          <div class="rw-bar"><div class="rw-bar-in" style="width:${r.canExchange > 0 ? 100 : (r.points / r.couponCost) * 100}%"></div></div>
          <div class="rw-need">${r.canExchange > 0 ? '可兑换 ' + r.canExchange + ' 张，去换一张吧' : '再得 ' + (r.couponCost - (r.points % r.couponCost)) + ' 分就能兑换一张餐券'}</div>
        </div>
        <div class="rw-actions">
          <span class="rw-btn ${r.canExchange > 0 ? '' : 'disabled'}" id="mnCoupon">兑换餐券</span>
          <span class="rw-btn plain" id="mnCoupon2">我的餐券</span>
        </div>
        <div class="rw-repair" id="mnRepair"><span>归还成功却没加积分？点此自检补发</span><span>›</span></div>
      </div>

      <div class="tabs">
        ${['我的帖子', '收到的申请', '我的申请'].map((t, i) => `<span class="tab-pill ${s.tabIndex === i ? 'tab-on' : ''}" data-t="${i}">${t}</span>`).join('')}
      </div>
      <div style="height:12px"></div>
      <div class="pane">${renderPane()}</div>

      <div class="card settings">
        <div class="card-title">提醒设置</div>
        <div class="set-tip">站内「消息」是主通道，一定会收到。邮件与短信是可选增强。</div>
        <div class="set-row"><span class="set-k">邮箱</span><input class="set-input" id="mnEmail" placeholder="用于接收匹配提醒" value="${esc(s.profile.email)}" /></div>
        <div class="set-row"><span class="set-k">邮件提醒</span>
          <label class="switch"><input type="checkbox" id="mnNe" ${s.profile.notifyEmail ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <div class="set-row"><span class="set-k">手机号</span><input class="set-input" id="mnPhone" type="tel" placeholder="用于接收短信提醒" value="${esc(s.profile.phone)}" /></div>
        <div class="set-row"><span class="set-k">短信提醒</span>
          <label class="switch"><input type="checkbox" id="mnNs" ${s.profile.notifySms ? 'checked' : ''} /><span class="slider"></span></label>
        </div>
        <button class="btn-primary set-save" id="mnSave">保存设置</button>
      </div>

      <div class="card about">
        <div class="card-title">使用说明</div>
        <div class="about-line">1. 丢了东西发「失物帖」，捡到东西发「招领帖」。</div>
        <div class="about-line">2. 发帖后系统会持续与反向帖子比对，有匹配自动推送到「消息」。</div>
        <div class="about-line">3. 看到匹配的帖子，发起认领并说明细节，对方同意后双方才互相可见联系方式。</div>
        <div class="about-line">4. 物品已找回请点「结束信息」，避免继续打扰。</div>
        <div class="about-line">5. 捡到东西并成功归还，你会 +1 积分；同一对同学之间只计一次，防止熟人互刷。</div>
        <div class="about-line">6. 满 ${r.couponCost} 分可兑换一张食堂餐券，凭核销码到食堂领取。</div>
      </div>`;

    // 事件
    root.querySelectorAll('.tab-pill[data-t]').forEach((el) => {
      el.onclick = () => { s.tabIndex = Number(el.dataset.t); render(); };
    });
    $('#mnCoupon').onclick = $('#mnCoupon2').onclick = () => (location.hash = '#/coupon');
    $('#mnRepair').onclick = repair;
    root.querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => (location.hash = '#/detail?id=' + el.dataset.open)));
    root.querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => copyText(el.dataset.copy)));
    root.querySelectorAll('[data-close]').forEach((el) => {
      el.onclick = async (e) => {
        e.stopPropagation();
        const ok = await modal('结束这条信息？', '确认后不再出现在搜索结果中，也不会再参与匹配。');
        if (!ok) return;
        const res = await api.closePost(el.dataset.close);
        if (res.ok) { toast('已结束'); load(); } else toast(res.errMsg || '操作失败');
      };
    });
    root.querySelectorAll('[data-claim]').forEach((el) => {
      el.onclick = async () => {
        const accept = el.dataset.accept === 'true';
        const ok = await modal(accept ? '同意认领？' : '拒绝该申请？',
          accept ? '同意后双方互相可见联系方式，帖子标记为已认领；捡到物品的一方 +1 积分。'
                 : '拒绝后对方会收到通知，你可以继续等待其他认领。');
        if (!ok) return;
        const res = accept ? await api.claimAccept(el.dataset.claim) : await api.claimReject(el.dataset.claim);
        if (res && res.ok) {
          if (accept && res.credited) toast(res.creditedTo === 'me' ? '已同意，你 +1 积分' : '已同意，对方 +1 积分');
          else toast(accept ? '已同意' : '已拒绝');
        } else toast((res && res.errMsg) || '操作失败');
        load(); refreshBadge();
      };
    });
    $('#mnSave').onclick = async () => {
      const p = {
        email: $('#mnEmail').value.trim(),
        notifyEmail: $('#mnNe').checked,
        phone: $('#mnPhone').value.trim(),
        notifySms: $('#mnNs').checked
      };
      if (p.notifyEmail && !p.email) return toast('请先填写邮箱');
      if (p.notifySms && !p.phone) return toast('请先填写手机号');
      const r = await api.saveProfile(p);
      toast(r.ok ? '已保存' : '保存失败');
    };
  }

  function mapPost(p) {
    return Object.assign({}, p, {
      titleText: postTitle(p),
      timeText: relativeTime(p.eventTime || p.createTime),
      statusLabel: statusText(p.status)
    });
  }

  function renderPane() {
    if (s.tabIndex === 0) {
      if (s.loaded && !s.myPosts.length) {
        return `<div class="empty"><div class="empty-icon">📝</div><div class="empty-title">你还没有发布过信息</div>
          <button class="btn-primary empty-btn" onclick="location.hash='#/publish'">发布一条</button></div>`;
      }
      return s.myPosts.map((raw) => {
        const p = mapPost(raw);
        return `<div class="post-item" data-open="${esc(p._id)}">
          <div class="pi-head">
            <span class="tag ${p.type === 'lost' ? 'tag-lost' : 'tag-found'}">${p.type === 'lost' ? '失物' : '招领'}</span>
            <span class="pi-title">${esc(p.titleText)}</span>
            <span class="pi-status ${p.status === 'active' ? 'st-active' : 'st-over'}">${esc(p.statusLabel)}</span>
          </div>
          <div class="pi-desc clamp-2">${esc(p.description)}</div>
          <div class="pi-foot"><span>${esc(p.timeText)}</span>
            ${p.status === 'active' ? `<span class="pi-close" data-close="${esc(p._id)}">结束信息</span>` : ''}
          </div>
        </div>`;
      }).join('');
    }
    const isIn = s.tabIndex === 1;
    const list = isIn ? s.incoming : s.outgoing;
    if (s.loaded && !list.length) {
      return `<div class="empty"><div class="empty-icon">${isIn ? '📥' : '📤'}</div>
        <div class="empty-title">${isIn ? '还没有人申请认领你的物品' : '你还没有申请认领过'}</div>
        <div class="empty-desc">${isIn ? '有人认领时会同时出现在「消息」里。' : '在广场里找到可疑的物品，点进去就能申请认领。'}</div></div>`;
    }
    return list.map((c) => {
      const p = c.post ? mapPost(c.post) : null;
      const contact = isIn ? c.claimerContact : c.contact;
      return `<div class="claim-card">
        <div class="cc-head">
          <span class="cc-status ${c.status}">${CLAIM_STATUS[c.status] || '待处理'}</span>
          <span class="cc-time">${esc(relativeTime(c.createTime))}</span>
        </div>
        ${p ? `<div class="cc-post" data-open="${esc(p._id)}">
          <span class="cc-ptitle">${esc(p.titleText)}</span>
          <span class="cc-pdesc clamp-2">${esc(p.description)}</span>
        </div>` : ''}
        ${c.message ? `<div class="cc-note">${isIn ? '对方' : '我的'}留言：${esc(c.message)}</div>` : ''}
        ${c.status === 'accepted' && contact ? `
        <div class="cc-contact">
          <div class="cc-ctitle">🔓 对方联系方式</div>
          ${contact.wechat ? `<span class="cc-citem" data-copy="${esc(contact.wechat)}">微信：${esc(contact.wechat)}（点击复制）</span>` : ''}
          ${contact.phone ? `<span class="cc-citem" data-copy="${esc(contact.phone)}">手机：${esc(contact.phone)}（点击复制）</span>` : ''}
        </div>` : ''}
        ${c.status === 'pending' ? (isIn
          ? `<div class="cc-actions">
              <span class="cc-btn" data-claim="${esc(c._id)}" data-accept="true">是他，同意</span>
              <span class="cc-btn plain" data-claim="${esc(c._id)}" data-accept="false">不是，拒绝</span>
            </div>`
          : '<div class="cc-tip">等待对方确认中…</div>') : ''}
        ${c.status === 'rejected' ? '<div class="cc-tip">对方确认后认为不是你的物品</div>' : ''}
      </div>`;
    }).join('');
  }

  async function repair() {
    const dry = await api.repairPoints(true);
    if (!dry.ok) return toast(dry.errMsg || '检查失败');
    if (!dry.willCredit) {
      return modal('积分正常', dry.already > 0
        ? '你已有的 ' + dry.already + ' 次归还都已计过分，无需补发。'
        : '没有检测到漏发的归还积分。', { showCancel: false });
    }
    const ok = await modal('发现 ' + dry.willCredit + ' 次漏发',
      '检测到 ' + dry.willCredit + ' 次「已归还但没加分」的记录，现在补发每人 1 分吗？');
    if (!ok) return;
    const r = await api.repairPoints(false);
    if (r.ok) {
      await modal('补发完成', '已补发 ' + r.credited + ' 次归还积分，当前积分 ' + (r.myPoints || 0) + ' 分。', { showCancel: false });
      load();
    } else toast(r.errMsg || '补发失败');
  }

  render();
  await load();
}

// ==================== 页面：餐券 ====================
async function pageCoupon() {
  host.innerHTML = `<div class="page no-tab" id="cp"><div class="loading">加载中…</div></div>`;
  const root = $('#cp');
  const s = { tabIndex: 0, points: 0, couponCost: 2, canExchange: 0, nextNeed: 2, returnCount: 0, list: [], loaded: false, exchanging: false, newCoupon: null, verifyCode: '', verifyErr: '' };

  async function load() {
    const status = s.tabIndex === 0 ? 'unused' : 'used';
    const [sum, listRes] = await Promise.all([api.rewardSummary(), api.rewardCoupons(status)]);
    if (sum.ok) {
      s.points = sum.points || 0;
      s.couponCost = sum.couponCost || 2;
      s.canExchange = sum.canExchange || 0;
      s.nextNeed = s.couponCost - (s.points % s.couponCost);
      s.returnCount = sum.returnCount || 0;
    }
    s.list = ((listRes.ok && listRes.list) || []).map((c) => ({
      ...c,
      createTimeText: formatDateTime(c.createTime),
      usedTimeText: c.usedTime ? formatDateTime(c.usedTime) : ''
    }));
    s.loaded = true;
    render();
  }

  function render() {
    root.innerHTML = `
      <div class="card sum">
        <div class="sum-left">
          <div class="sum-num">${s.points}<span class="sum-unit">分</span></div>
          <div class="sum-sub">已成功归还 ${s.returnCount} 次 · 每次 +1 分</div>
        </div>
        <div class="sum-right">
          <div class="sum-rule">${s.couponCost} 分 = 1 张餐券</div>
          <span class="sum-btn ${s.canExchange > 0 ? '' : 'disabled'}" id="cpEx">${s.canExchange > 0 ? '兑换一张' : '还差 ' + s.nextNeed + ' 分'}</span>
        </div>
      </div>

      ${s.newCoupon ? `
      <div class="card new-coupon">
        <div class="nc-title">🎉 兑换成功，请出示给食堂窗口</div>
        <div class="nc-code">${esc(s.newCoupon.code)}</div>
        <div class="nc-tip">${esc(s.newCoupon.tip)}</div>
        <div class="nc-actions">
          <span class="nc-btn" data-copy="${esc(s.newCoupon.code)}">复制核销码</span>
          <span class="nc-btn plain" id="cpCloseNew">知道了</span>
        </div>
      </div>` : ''}

      <div class="tabs">
        <span class="tab-pill ${s.tabIndex === 0 ? 'tab-on' : ''}" data-t="0">未使用</span>
        <span class="tab-pill ${s.tabIndex === 1 ? 'tab-on' : ''}" data-t="1">已核销</span>
      </div>
      <div style="height:12px"></div>

      ${s.list.map((c) => `
      <div class="coupon">
        <div class="cp-left">
          <div class="cp-name">食堂餐券</div>
          <div class="cp-code ${c.status === 'used' ? 'cp-code-used' : ''}">${esc(c.code)}</div>
          <div class="cp-time">${c.status === 'used' ? '核销于 ' + c.usedTimeText : '兑换于 ' + c.createTimeText}</div>
        </div>
        <div class="cp-right">
          <div class="cp-status ${c.status}">${c.status === 'used' ? '已核销' : '待使用'}</div>
          <span class="cp-cost">${c.cost} 分</span>
          ${c.status !== 'used' ? `<span class="cp-copy" data-copy="${esc(c.code)}">复制</span>` : ''}
        </div>
      </div>`).join('')}

      ${s.loaded && !s.list.length ? `
      <div class="empty">
        <div class="empty-icon">🎟️</div>
        <div class="empty-title">${s.tabIndex === 0 ? '还没有可用的餐券' : '还没有核销记录'}</div>
        <div class="empty-desc">每成功归还一件物品 +1 分，满 ${s.couponCost} 分就能兑换一张。</div>
        <button class="btn-primary empty-btn" id="cpGoPub">去发布招领信息</button>
      </div>` : ''}

      <div class="card verify">
        <div class="card-title">食堂核销</div>
        <div class="vf-tip">窗口工作人员输入同学出示的核销码，确认后即可发放餐券。（演示时你自己输入也能核销）</div>
        <input class="input" id="cpCode" placeholder="输入 8 位核销码" maxlength="12" value="${esc(s.verifyCode)}" style="width:100%" />
        ${s.verifyErr ? `<div class="vf-err">${esc(s.verifyErr)}</div>` : ''}
        <button class="btn-primary vf-btn" id="cpVerify">确认核销</button>
      </div>`;

    root.querySelectorAll('.tab-pill[data-t]').forEach((el) => {
      el.onclick = () => { s.tabIndex = Number(el.dataset.t); load(); };
    });
    $('#cpEx').onclick = exchange;
    root.querySelectorAll('[data-copy]').forEach((el) => (el.onclick = () => copyText(el.dataset.copy)));
    const cn = $('#cpCloseNew');
    if (cn) cn.onclick = () => { s.newCoupon = null; render(); };
    const gp = $('#cpGoPub');
    if (gp) gp.onclick = () => (location.hash = '#/publish');
    $('#cpCode').oninput = (e) => { s.verifyCode = e.target.value; s.verifyErr = ''; };
    $('#cpVerify').onclick = verify;
  }

  async function exchange() {
    if (s.exchanging) return;
    if (s.canExchange <= 0) return toast('积分不足，满 ' + s.couponCost + ' 分才能兑换');
    const ok = await modal('兑换餐券', '消耗 ' + s.couponCost + ' 积分兑换 1 张食堂餐券，确认吗？');
    if (!ok) return;
    s.exchanging = true;
    const r = await api.rewardExchange();
    s.exchanging = false;
    if (!r.ok) return modal('兑换失败', r.errMsg || '请稍后重试', { showCancel: false });
    s.newCoupon = { code: r.code, tip: r.tip || '到食堂出示核销码即可领取餐券' };
    s.points = r.points || s.points;
    toast('兑换成功');
    await load();
  }

  async function verify() {
    const code = s.verifyCode.trim().toUpperCase();
    if (!code) return toast('请输入核销码');
    const r = await api.rewardVerify(code);
    if (r.ok) {
      toast('核销成功');
      s.verifyCode = '';
      await load();
    } else {
      s.verifyErr = r.errMsg || '核销失败';
      render();
    }
  }

  await load();
}

// ==================== 路由 ====================
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const params = {};
  if (qs) new URLSearchParams(qs).forEach((v, k) => (params[k] = v));
  return { page: path || 'square', params };
}

async function router() {
  const { page, params } = parseHash();
  setNav(page);
  window.scrollTo(0, 0);
  const pages = { square: pageSquare, publish: pagePublish, message: pageMessage, mine: pageMine, detail: pageDetail, coupon: pageCoupon };
  const fn = pages[page] || pageSquare;
  try {
    await fn(params);
  } catch (e) {
    console.error(e);
    host.innerHTML = `<div class="page"><div class="err">⚠️ 页面加载出错：${esc(e.message || e)}</div></div>`;
  }
}

// 首次进入：登录 + 首次访问自动灌演示数据
(async function boot() {
  getUid();
  try {
    await api.login();
    const seeded = localStorage.getItem('clf_seeded');
    if (!seeded) {
      const r = await api.seed();
      if (r && r.seeded) localStorage.setItem('clf_seeded', '1');
    }
  } catch (e) { /* 后端未就绪也照样渲染页面 */ }
  window.addEventListener('hashchange', router);
  router();
})();
