'use strict';
// 학부모 익명 소통방 - 프론트엔드 (프레임워크 없이 동작)

const $app = document.getElementById('app');
const state = { me: null, category: '', sort: 'latest', q: '' };

// ---------- 공통 유틸 ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || '오류가 발생했습니다.');
    err.status = res.status;
    throw err;
  }
  return data;
}

// 안전한 DOM 생성 (사용자 입력은 항상 textContent로 넣어 XSS 방지)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSP 호환
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2500);
}

function timeAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '방금';
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}일 전`;
  const dt = new Date(ts);
  return `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}`;
}

function render(...nodes) {
  $app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function handleError(e) {
  if (e.status === 401 && !state.me?.admin) {
    state.me.entered = false;
    return route();
  }
  toast(e.message);
}

// ---------- 화면: 입장 ----------
function viewEnter() {
  const input = h('input', { type: 'password', inputmode: 'numeric', placeholder: '입장 코드', autocomplete: 'off', class: 'input big' });
  const submit = async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/enter', { code: input.value });
      state.me.entered = true;
      toast('환영합니다! 모든 글은 익명으로 작성됩니다.');
      route();
    } catch (e) { toast(e.message); }
  };
  render(
    h('section', { class: 'card enter' },
      h('div', { class: 'enter-icon' }, '🌱'),
      h('h1', {}, state.me.schoolName),
      h('p', { class: 'muted' }, '학교에서 안내받은 입장 코드를 입력해주세요.'),
      h('form', { onsubmit: submit }, input, h('button', { class: 'btn primary block' }, '입장하기')),
      h('ul', { class: 'promise' },
        h('li', {}, '🔒 회원가입·실명·전화번호를 받지 않습니다.'),
        h('li', {}, '🎭 글마다 다른 익명 닉네임이 자동으로 붙습니다.'),
        h('li', {}, '🛡 전화번호·이메일은 자동으로 가려집니다.'),
        h('li', {}, '🚨 신고가 누적된 글은 자동으로 숨김 처리됩니다.'),
      ),
    ),
  );
  input.focus();
}

// ---------- 화면: 목록 ----------
async function viewList() {
  const cats = state.me.categories;
  const tabs = h('nav', { class: 'tabs' },
    [['', '전체'], ...Object.entries(cats)].map(([k, v]) =>
      h('button', { class: 'tab' + (state.category === k ? ' active' : ''), onclick: () => { state.category = k; viewList(); } }, v)),
  );
  const search = h('input', { class: 'input', type: 'search', placeholder: '검색어', value: state.q });
  const searchForm = h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); state.q = search.value; viewList(); } },
    search,
    h('select', { class: 'input sort', onchange: (e) => { state.sort = e.target.value; viewList(); } },
      h('option', { value: 'latest', selected: state.sort === 'latest' }, '최신순'),
      h('option', { value: 'popular', selected: state.sort === 'popular' }, '공감순')),
  );
  const list = h('ul', { class: 'post-list' }, h('li', { class: 'empty' }, '불러오는 중…'));
  const more = h('div', { class: 'center' });

  render(
    h('div', { class: 'intro' }, h('h1', {}, state.me.schoolName), h('p', { class: 'muted' }, '서로 존중하는 대화를 부탁드립니다. 모든 글은 익명입니다.')),
    tabs, searchForm, list, more,
    h('a', { href: '#/write', class: 'fab', title: '글쓰기' }, '✏️ 글쓰기'),
  );

  let page = 1;
  const load = async () => {
    try {
      const qs = new URLSearchParams({ page, sort: state.sort });
      if (state.category) qs.set('category', state.category);
      if (state.q) qs.set('q', state.q);
      const data = await api('GET', '/api/posts?' + qs);
      if (page === 1) list.replaceChildren();
      if (!data.posts.length && page === 1) list.append(h('li', { class: 'empty' }, '아직 글이 없어요. 첫 글을 남겨주세요!'));
      for (const p of data.posts) list.append(postItem(p));
      more.replaceChildren(data.hasMore ? h('button', { class: 'btn', onclick: () => { page++; load(); } }, '더 보기') : '');
    } catch (e) { handleError(e); }
  };
  load();
}

function postItem(p) {
  return h('li', { class: 'post-item' + (p.pinned ? ' pinned' : '') + (p.hidden ? ' is-hidden' : '') },
    h('a', { href: `#/post/${p.id}` },
      h('div', { class: 'meta-top' },
        p.pinned && h('span', { class: 'badge pin' }, '📌 고정'),
        h('span', { class: `badge cat-${p.category}` }, p.categoryName),
        p.hidden && h('span', { class: 'badge warn' }, '숨김'),
      ),
      h('div', { class: 'title' }, p.title),
      p.preview && h('div', { class: 'preview' }, p.preview),
      h('div', { class: 'meta' },
        h('span', { class: p.isAdmin ? 'nick admin' : 'nick' }, p.nickname),
        h('span', {}, timeAgo(p.createdAt)),
        h('span', {}, `♥ ${p.likes}`),
        h('span', {}, `💬 ${p.commentCount}`),
        p.reports != null && p.reports > 0 && h('span', { class: 'warn-text' }, `신고 ${p.reports}`),
      ),
    ),
  );
}

// ---------- 화면: 상세 ----------
async function viewPost(id) {
  let data;
  try { data = await api('GET', `/api/posts/${id}`); } catch (e) { handleError(e); return; }
  const { post: p, comments } = data;
  const admin = state.me.admin;

  const likeBtn = h('button', { class: 'btn like' + (p.liked ? ' on' : ''), onclick: async () => {
    try {
      const r = await api('POST', `/api/posts/${id}/like`);
      likeBtn.classList.toggle('on', r.liked);
      likeBtn.textContent = `♥ 공감 ${r.likes}`;
    } catch (e) { handleError(e); }
  } }, `♥ 공감 ${p.likes}`);

  const actions = h('div', { class: 'actions' }, likeBtn);
  if (!p.mine) actions.append(h('button', { class: 'btn ghost', onclick: () => doReport('posts', id) }, '🚨 신고'));
  if (p.mine || admin) actions.append(h('button', { class: 'btn ghost danger', onclick: async () => {
    if (!confirm('이 글을 삭제할까요? 되돌릴 수 없습니다.')) return;
    try { await api('DELETE', `/api/posts/${id}`); toast('삭제되었습니다.'); location.hash = '#/'; } catch (e) { handleError(e); }
  } }, '삭제'));

  const adminBar = admin && h('div', { class: 'admin-bar' },
    h('span', {}, '운영자 도구'),
    adminAction(p.pinned ? '고정 해제' : '상단 고정', `/api/admin/posts/${id}/${p.pinned ? 'unpin' : 'pin'}`, () => viewPost(id)),
    adminAction(p.hidden ? '숨김 해제' : '숨김', `/api/admin/posts/${id}/${p.hidden ? 'unhide' : 'hide'}`, () => viewPost(id)),
  );

  const commentList = h('ul', { class: 'comments' },
    comments.length ? comments.map((c) => commentItem(c, id)) : h('li', { class: 'empty' }, '첫 댓글을 남겨주세요.'));

  const ta = h('textarea', { class: 'input', rows: 3, maxlength: 1000, placeholder: '따뜻한 댓글을 남겨주세요 (익명)' });
  const asAdminChk = admin && h('input', { type: 'checkbox', checked: true });
  const form = h('form', { class: 'comment-form', onsubmit: async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    try {
      await api('POST', `/api/posts/${id}/comments`, { body: ta.value, asAdmin: asAdminChk ? asAdminChk.checked : undefined });
      viewPost(id);
    } catch (err) { handleError(err); }
  } },
  ta,
  h('div', { class: 'row' },
    admin ? h('label', { class: 'chk' }, asAdminChk, ' 운영자로 표시') : h('span', { class: 'muted small' }, '이 글에서는 “익명N”으로 표시됩니다.'),
    h('button', { class: 'btn primary' }, '등록')));

  render(
    h('a', { href: '#/', class: 'back' }, '← 목록'),
    h('article', { class: 'card post' + (p.hidden ? ' is-hidden' : '') },
      h('div', { class: 'meta-top' },
        p.pinned && h('span', { class: 'badge pin' }, '📌 고정'),
        h('span', { class: `badge cat-${p.category}` }, p.categoryName),
        p.hidden && h('span', { class: 'badge warn' }, '숨김'),
      ),
      h('h2', {}, p.title),
      h('div', { class: 'meta' },
        h('span', { class: p.isAdmin ? 'nick admin' : 'nick' }, p.nickname),
        p.mine && h('span', { class: 'badge mine' }, '내 글'),
        h('span', {}, timeAgo(p.createdAt)),
        p.reports > 0 && h('span', { class: 'warn-text' }, `신고 ${p.reports}`),
      ),
      h('div', { class: 'body' }, p.body),
      actions,
      adminBar,
    ),
    h('section', { class: 'card' }, h('h3', {}, `댓글 ${comments.length}`), commentList, form),
  );
}

function commentItem(c, postId) {
  const admin = state.me.admin;
  return h('li', { class: 'comment' + (c.hidden ? ' is-hidden' : '') },
    h('div', { class: 'meta' },
      h('span', { class: c.isAdmin ? 'nick admin' : c.label === '글쓴이' ? 'nick op' : 'nick' }, c.label),
      c.mine && h('span', { class: 'badge mine' }, '나'),
      h('span', {}, timeAgo(c.createdAt)),
      c.reports > 0 && h('span', { class: 'warn-text' }, `신고 ${c.reports}`),
      h('span', { class: 'spacer' }),
      !c.mine && h('button', { class: 'link', onclick: () => doReport('comments', c.id) }, '신고'),
      (c.mine || admin) && h('button', { class: 'link danger', onclick: async () => {
        if (!confirm('댓글을 삭제할까요?')) return;
        try { await api('DELETE', `/api/comments/${c.id}`); viewPost(postId); } catch (e) { handleError(e); }
      } }, '삭제'),
      admin && adminAction(c.hidden ? '숨김해제' : '숨김', `/api/admin/comments/${c.id}/${c.hidden ? 'unhide' : 'hide'}`, () => viewPost(postId), 'link'),
    ),
    h('div', { class: 'body' }, c.body),
  );
}

function adminAction(label, url, after, cls = 'btn small') {
  return h('button', { class: cls, onclick: async () => {
    try { await api('POST', url); after(); } catch (e) { handleError(e); }
  } }, label);
}

async function doReport(kind, id) {
  const reason = prompt('신고 사유를 간단히 적어주세요.\n(예: 특정인 비방, 개인정보 노출, 광고)');
  if (reason === null) return;
  try {
    const r = await api('POST', `/api/${kind}/${id}/report`, { reason });
    toast(r.hidden ? '신고가 누적되어 숨김 처리되었습니다.' : '신고가 접수되었습니다. 감사합니다.');
  } catch (e) { handleError(e); }
}

// ---------- 화면: 글쓰기 ----------
function viewWrite() {
  const cats = Object.entries(state.me.categories).filter(([k]) => k !== 'notice' || state.me.admin);
  const category = h('select', { class: 'input' }, cats.map(([k, v]) => h('option', { value: k, selected: k === (state.category || 'free') }, v)));
  const title = h('input', { class: 'input', maxlength: 100, placeholder: '제목' });
  const body = h('textarea', { class: 'input', rows: 10, maxlength: 5000, placeholder: '내용을 입력하세요.\n\n아이 이름·반·연락처 등 개인을 특정할 수 있는 정보는 적지 않는 것을 권장합니다.' });
  const asAdminChk = state.me.admin && h('input', { type: 'checkbox', checked: true });
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/posts', { category: category.value, title: title.value, body: body.value, asAdmin: asAdminChk ? asAdminChk.checked : undefined });
      toast('등록되었습니다.');
      location.hash = `#/post/${r.id}`;
    } catch (err) { handleError(err); }
  };
  render(
    h('a', { href: '#/', class: 'back' }, '← 목록'),
    h('form', { class: 'card write', onsubmit: submit },
      h('h2', {}, '익명 글쓰기'),
      h('label', {}, '말머리', category),
      h('label', {}, '제목', title),
      h('label', {}, '내용', body),
      asAdminChk && h('label', { class: 'chk' }, asAdminChk, ' 운영자로 표시'),
      h('p', { class: 'notice-box' }, '🎭 닉네임은 글마다 무작위로 정해지며, 학교·운영자도 작성자를 알 수 없습니다. 비방·욕설·허위사실은 신고 시 숨김 처리됩니다.'),
      h('button', { class: 'btn primary block' }, '등록하기'),
    ),
  );
  title.focus();
}

// ---------- 화면: 운영자 ----------
async function viewAdmin() {
  if (!state.me.admin) {
    const pw = h('input', { type: 'password', class: 'input', placeholder: '운영자 비밀번호' });
    render(
      h('a', { href: '#/', class: 'back' }, '← 목록'),
      h('form', { class: 'card', onsubmit: async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/admin/login', { password: pw.value }); await loadMe(); toast('운영자로 로그인했습니다.'); route(); }
        catch (err) { toast(err.message); }
      } },
      h('h2', {}, '운영자 로그인'),
      h('p', { class: 'muted' }, '선생님 또는 학부모회 운영진 전용입니다.'),
      pw, h('button', { class: 'btn primary block' }, '로그인')),
    );
    return;
  }
  let stats, reports;
  try { [stats, reports] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/reports')]); }
  catch (e) { handleError(e); return; }

  render(
    h('a', { href: '#/', class: 'back' }, '← 목록'),
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', {}, '운영 현황 (최근 7일)'),
        h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/admin/logout'); await loadMe(); location.hash = '#/'; } }, '로그아웃')),
      h('div', { class: 'stats' },
        stat('누적 글', stats.total), stat('이번 주 글', stats.week), stat('이번 주 댓글', stats.weekComments)),
      h('h3', {}, '말머리별 (7일)'),
      h('div', { class: 'bars' }, stats.byCategory.length ? stats.byCategory.map((c) => {
        const max = Math.max(...stats.byCategory.map((x) => x.n));
        return h('div', { class: 'bar-row' }, h('span', {}, c.name), h('div', { class: 'bar' }, h('i', { style: `width:${(c.n / max) * 100}%` })), h('b', {}, c.n));
      }) : h('p', { class: 'muted' }, '데이터 없음')),
      h('h3', {}, '관심 많은 글 TOP 5 (7일)'),
      h('ol', { class: 'top' }, stats.top.map((t) => h('li', {}, h('a', { href: `#/post/${t.id}` }, `[${t.category}] ${t.title}`), h('span', { class: 'muted' }, ` ♥${t.likes} 💬${t.comments}`)))),
    ),
    h('section', { class: 'card' },
      h('h2', {}, '신고·숨김 관리'),
      h('h3', {}, `글 (${reports.posts.length})`),
      reports.posts.length ? h('ul', { class: 'post-list' }, reports.posts.map((p) => h('li', {},
        postItem(p),
        p.reasons.length > 0 && h('div', { class: 'reasons' }, '사유: ' + p.reasons.join(' / '))))) : h('p', { class: 'muted' }, '없음'),
      h('h3', {}, `댓글 (${reports.comments.length})`),
      reports.comments.length ? h('ul', { class: 'comments' }, reports.comments.map((c) => h('li', { class: 'comment' + (c.hidden ? ' is-hidden' : '') },
        h('div', { class: 'meta' }, h('a', { href: `#/post/${c.postId}` }, `글 #${c.postId}`), h('span', {}, c.label), h('span', { class: 'warn-text' }, `신고 ${c.reports}`), c.hidden && h('span', { class: 'badge warn' }, '숨김')),
        h('div', { class: 'body' }, c.body),
        c.reasons.length > 0 && h('div', { class: 'reasons' }, '사유: ' + c.reasons.join(' / ')),
        h('div', { class: 'actions' },
          adminAction(c.hidden ? '숨김 해제' : '숨김', `/api/admin/comments/${c.id}/${c.hidden ? 'unhide' : 'hide'}`, viewAdmin))))) : h('p', { class: 'muted' }, '없음'),
    ),
  );
}

const stat = (label, n) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, label));

// ---------- 라우터 ----------
async function loadMe() {
  state.me = await api('GET', '/api/me');
  document.getElementById('brand').textContent = state.me.schoolName;
  document.title = state.me.schoolName;
  document.getElementById('adminBadge').classList.toggle('hidden', !state.me.admin);
}

function route() {
  const hash = location.hash || '#/';
  if (!state.me.entered && hash !== '#/admin') return viewEnter();
  let m;
  if ((m = hash.match(/^#\/post\/(\d+)/))) return viewPost(m[1]);
  if (hash === '#/write') return viewWrite();
  if (hash === '#/admin') return viewAdmin();
  return viewList();
}

window.addEventListener('hashchange', route);
loadMe().then(route).catch(() => render(h('p', { class: 'card' }, '서버에 연결할 수 없습니다.')));
