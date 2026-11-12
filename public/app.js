'use strict';
// 학부모 익명 소통방 - 메신저형 프론트엔드 (프레임워크 없이 동작)

const $app = document.getElementById('app');
const $top = document.getElementById('topbar');
const $nav = document.getElementById('bottomNav');
const state = { me: null, category: '', sort: 'latest', q: '', showSearch: false };
let poller = null;

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

// 안전한 DOM 생성 (사용자 입력은 항상 텍스트로 넣어 XSS 방지)
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

// 아래에서 올라오는 메뉴 (신고/삭제 등)
function sheet(title, items) {
  const bd = document.getElementById('sheet');
  const close = () => bd.classList.add('hidden');
  bd.replaceChildren(h('div', { class: 'sheet', onclick: (e) => e.stopPropagation() },
    title && h('div', { class: 'sheet-title' }, title),
    items.filter(Boolean).map((it) => h('button', { class: 'sheet-item' + (it.danger ? ' danger' : ''), onclick: () => { close(); it.run(); } }, it.label)),
    h('button', { class: 'sheet-item cancel', onclick: close }, '취소'),
  ));
  bd.onclick = close;
  bd.classList.remove('hidden');
}

const pad = (n) => String(n).padStart(2, '0');
function timeAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return '방금';
  if (d < 3600) return `${Math.floor(d / 60)}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 86400 * 2) return '어제';
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일`;
}
function clock(ts) {
  const d = new Date(ts);
  const hh = d.getHours();
  return `${hh < 12 ? '오전' : '오후'} ${hh % 12 || 12}:${pad(d.getMinutes())}`;
}
function dayLabel(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}요일`;
}

function avatar(content, cls = '') {
  return h('div', { class: 'avatar ' + cls }, content);
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

// 상단바: 홈은 로고+학교명, 하위 화면은 ← 뒤로가기
function topbar({ title, back, right } = {}) {
  const logo = state.me.logo ? h('img', { src: state.me.logo, alt: '', class: 'logo' }) : h('img', { src: '/icon.svg', alt: '', class: 'logo' });
  $top.replaceChildren(
    back ? h('button', { class: 'icon-btn', onclick: () => (history.length > 1 ? history.back() : (location.hash = '#/')), 'aria-label': '뒤로' }, '‹') : logo,
    h('div', { class: 'top-title' }, title || state.me.schoolName),
    h('div', { class: 'top-right' }, state.me.admin && h('span', { class: 'badge admin' }, '운영자'), right),
  );
}

function setNav(tab) {
  $nav.classList.toggle('hidden', !tab);
  document.body.classList.toggle('with-nav', !!tab);
  for (const a of $nav.querySelectorAll('a')) a.classList.toggle('active', a.dataset.tab === tab);
}

// ---------- 화면: 입장 ----------
function viewEnter() {
  setNav(null);
  $top.replaceChildren();
  $top.classList.add('hidden');
  const input = h('input', { type: 'password', inputmode: 'numeric', placeholder: '입장 코드', autocomplete: 'off', class: 'input big' });
  const submit = async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/enter', { code: input.value });
      state.me.entered = true;
      $top.classList.remove('hidden');
      toast('환영합니다! 모든 글은 익명으로 작성됩니다.');
      route();
    } catch (e) { toast(e.message); }
  };
  render(
    h('section', { class: 'enter' },
      state.me.logoFull
        ? h('img', { src: state.me.logoFull, alt: state.me.schoolName, class: 'enter-logo-full' })
        : h('img', { src: state.me.logo || '/icon.svg', alt: '', class: 'enter-logo' }),
      h('h1', {}, state.me.logoFull ? '학부모 소통방' : state.me.schoolName),
      h('p', { class: 'muted' }, '학교에서 안내받은 입장 코드를 입력해주세요.'),
      h('form', { onsubmit: submit }, input, h('button', { class: 'btn primary block' }, '입장하기')),
      h('ul', { class: 'promise' },
        h('li', {}, '🔒 회원가입·실명·전화번호를 받지 않아요'),
        h('li', {}, '🎭 글마다 다른 익명 닉네임이 자동으로 붙어요'),
        h('li', {}, '🛡 전화번호·이메일은 자동으로 가려져요'),
        h('li', {}, '🚨 신고가 쌓인 글은 자동으로 숨겨져요'),
      ),
    ),
  );
  input.focus();
}

// ---------- 화면: 대화 목록 (홈 / 공지 / 내 활동) ----------
async function viewList(mode = 'home') {
  setNav(mode);
  const cats = state.me.categories;
  const titles = { home: null, notice: '공지사항', mine: '내 활동' };
  const searchToggle = mode === 'home' && h('button', { class: 'icon-btn', 'aria-label': '검색', onclick: () => { state.showSearch = !state.showSearch; viewList(mode); } }, '🔍');
  topbar({ title: titles[mode], right: searchToggle });

  const parts = [];
  if (mode === 'home') {
    if (state.showSearch || state.q) {
      const search = h('input', { class: 'input', type: 'search', placeholder: '제목·내용 검색', value: state.q });
      parts.push(h('form', { class: 'search', onsubmit: (e) => { e.preventDefault(); state.q = search.value.trim(); viewList(mode); } },
        search,
        state.q && h('button', { type: 'button', class: 'btn small', onclick: () => { state.q = ''; state.showSearch = false; viewList(mode); } }, '지우기')));
      setTimeout(() => !state.q && search.focus());
    }
    parts.push(h('div', { class: 'chips' },
      [['', '전체'], ...Object.entries(cats).filter(([k]) => k !== 'notice')].map(([k, v]) =>
        h('button', { class: 'chip' + (state.category === k ? ' active' : ''), onclick: () => { state.category = k; viewList(mode); } }, v)),
    ));
    parts.push(h('div', { class: 'sort-row' },
      [['latest', '최신순'], ['popular', '공감순']].map(([k, v]) =>
        h('button', { class: state.sort === k ? 'on' : '', onclick: () => { state.sort = k; viewList(mode); } }, v))));
  }
  if (mode === 'mine') parts.push(h('p', { class: 'hint' }, '내가 쓴 글과 댓글 단 대화방이에요. 이 기기에서만 보여요.'));

  const pinnedBox = h('div', {});
  const list = h('ul', { class: 'room-list' }, h('li', { class: 'empty' }, '불러오는 중…'));
  const more = h('div', { class: 'center' });
  render(...parts, pinnedBox, list, more);

  let page = 1;
  const load = async () => {
    try {
      const qs = new URLSearchParams({ page, sort: mode === 'home' ? state.sort : 'latest' });
      if (mode === 'notice') qs.set('category', 'notice');
      else if (mode === 'home' && state.category) qs.set('category', state.category);
      if (mode === 'home' && state.q) qs.set('q', state.q);
      if (mode === 'mine') qs.set('mine', '1');
      const data = await api('GET', '/api/posts?' + qs);
      if (page === 1) {
        list.replaceChildren();
        // 홈에서는 고정 글을 상단 공지 배너로
        if (mode === 'home') {
          const pinned = data.posts.filter((p) => p.pinned);
          pinnedBox.replaceChildren(...pinned.map((p) => h('a', { class: 'pin-banner', href: `#/post/${p.id}` }, h('b', {}, '📢'), h('span', {}, p.title), h('i', {}, '›'))));
          data.posts = data.posts.filter((p) => !p.pinned);
        }
      }
      if (!data.posts.length && page === 1) {
        list.append(h('li', { class: 'empty' },
          { home: state.q ? '검색 결과가 없어요.' : '아직 대화가 없어요.\n첫 이야기를 시작해보세요!', notice: '등록된 공지가 없어요.', mine: '아직 참여한 대화가 없어요.' }[mode]));
      }
      for (const p of data.posts) list.append(roomItem(p));
      more.replaceChildren(data.hasMore ? h('button', { class: 'btn', onclick: () => { page++; load(); } }, '더 보기') : '');
    } catch (e) { handleError(e); }
  };
  load();
}

function roomItem(p) {
  return h('li', { class: 'room' + (p.hidden ? ' is-hidden' : '') },
    h('a', { href: `#/post/${p.id}` },
      avatar(p.avatar, p.isAdmin ? 'admin' : ''),
      h('div', { class: 'room-main' },
        h('div', { class: 'room-title' },
          h('span', { class: `tag cat-${p.category}` }, p.categoryName),
          h('b', {}, p.title)),
        h('div', { class: 'room-preview' }, p.preview || (p.hidden ? '운영자 검토 중' : '')),
      ),
      h('div', { class: 'room-side' },
        h('span', { class: 'time' }, timeAgo(p.createdAt)),
        h('div', { class: 'counts' },
          p.likes > 0 && h('span', { class: 'like-count' }, `♥${p.likes}`),
          p.commentCount > 0 && h('span', { class: 'count' }, p.commentCount > 99 ? '99+' : p.commentCount)),
        p.reports > 0 && h('span', { class: 'warn-text small' }, `신고 ${p.reports}`),
      ),
    ),
  );
}

// ---------- 화면: 대화방 (글 상세 + 댓글을 말풍선으로) ----------
async function viewPost(id) {
  setNav(null);
  let data;
  try { data = await api('GET', `/api/posts/${id}`); } catch (e) { handleError(e); return; }
  const { post: p } = data;
  const admin = state.me.admin;

  const postMenu = () => sheet(p.title, [
    !p.mine && { label: '🚨 이 글 신고하기', run: () => doReport('posts', id) },
    (p.mine || admin) && { label: '🗑 글 삭제', danger: true, run: async () => {
      if (!confirm('이 글을 삭제할까요? 되돌릴 수 없습니다.')) return;
      try { await api('DELETE', `/api/posts/${id}`); toast('삭제되었습니다.'); location.hash = '#/'; } catch (e) { handleError(e); }
    } },
    admin && { label: p.pinned ? '📌 고정 해제' : '📌 상단 공지로 고정', run: () => adminCall(`/api/admin/posts/${id}/${p.pinned ? 'unpin' : 'pin'}`, () => viewPost(id)) },
    admin && { label: p.hidden ? '👁 숨김 해제' : '🙈 숨기기', run: () => adminCall(`/api/admin/posts/${id}/${p.hidden ? 'unhide' : 'hide'}`, () => viewPost(id)) },
  ]);
  topbar({ title: p.title, back: true, right: h('button', { class: 'icon-btn', 'aria-label': '메뉴', onclick: postMenu }, '⋯') });

  const thread = h('div', { class: 'chat' });
  const drawThread = (post, comments) => {
    const nodes = [h('div', { class: 'day' }, dayLabel(post.createdAt))];
    // 첫 메시지 = 원글
    const likeBtn = h('button', { class: 'like-btn' + (post.liked ? ' on' : ''), onclick: async () => {
      try {
        const r = await api('POST', `/api/posts/${id}/like`);
        likeBtn.classList.toggle('on', r.liked);
        likeBtn.textContent = `♥ 공감 ${r.likes}`;
      } catch (e) { handleError(e); }
    } }, `♥ 공감 ${post.likes}`);
    nodes.push(h('div', { class: 'msg first' + (post.mine ? ' me' : '') + (post.isAdmin ? ' from-admin' : '') },
      !post.mine && avatar(post.avatar, post.isAdmin ? 'admin' : ''),
      h('div', { class: 'msg-col' },
        h('div', { class: 'msg-name' }, post.mine ? '나 (글쓴이)' : `${post.nickname} · 글쓴이`),
        h('div', { class: 'msg-row' },
          h('div', { class: 'bubble post-bubble' + (post.hidden ? ' is-hidden' : '') },
            h('div', { class: 'post-head' },
              post.pinned && h('span', { class: 'tag pin' }, '📌 고정'),
              h('span', { class: `tag cat-${post.category}` }, post.categoryName),
              post.hidden && h('span', { class: 'tag warn' }, '숨김')),
            h('div', { class: 'post-title' }, post.title),
            h('div', { class: 'text' }, post.body),
            h('div', { class: 'post-foot' }, likeBtn, post.reports > 0 && h('span', { class: 'warn-text small' }, `신고 ${post.reports}`))),
          h('span', { class: 'msg-time' }, clock(post.createdAt))),
      ),
    ));

    let prevDay = new Date(post.createdAt).toDateString();
    let prevWho = null;
    for (const c of comments) {
      const day = new Date(c.createdAt).toDateString();
      if (day !== prevDay) { nodes.push(h('div', { class: 'day' }, dayLabel(c.createdAt))); prevDay = day; prevWho = null; }
      const who = c.isAdmin ? 'admin' : c.label;
      const showHead = who !== prevWho;
      prevWho = who;
      const av = c.isAdmin ? avatar('🏫', 'admin') : c.label === '글쓴이' ? avatar(post.avatar) : avatar(c.label.replace('익명', ''), 'num n' + (Number(c.label.replace('익명', '')) % 6));
      nodes.push(h('div', { class: 'msg' + (c.mine ? ' me' : '') + (showHead ? '' : ' cont') + (c.isAdmin ? ' from-admin' : '') },
        !c.mine && (showHead ? av : h('div', { class: 'avatar ghost' })),
        h('div', { class: 'msg-col' },
          showHead && !c.mine && h('div', { class: 'msg-name' }, c.isAdmin ? '✔ 운영자' : c.label),
          h('div', { class: 'msg-row' },
            h('div', { class: 'bubble' + (c.hidden ? ' is-hidden' : ''), onclick: () => commentMenu(c, id) }, h('div', { class: 'text' }, c.body)),
            h('span', { class: 'msg-time' }, c.reports > 0 ? h('span', { class: 'warn-text' }, `신고${c.reports} `) : '', clock(c.createdAt))),
        ),
      ));
    }
    if (!comments.length) nodes.push(h('div', { class: 'day soft' }, '아직 답글이 없어요. 첫 답글을 남겨주세요 🙂'));
    thread.replaceChildren(...nodes);
  };
  drawThread(p, data.comments);

  // 하단 입력창
  const ta = h('textarea', { class: 'composer-input', rows: 1, maxlength: 1000, placeholder: '익명으로 메시지 보내기' });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
  const asAdminChk = admin && h('input', { type: 'checkbox', checked: true });
  const sendBtn = h('button', { class: 'send-btn', 'aria-label': '보내기' }, '➤');
  let lastCount = data.comments.length;
  const refresh = async (scroll) => {
    const d = await api('GET', `/api/posts/${id}`);
    if (scroll || d.comments.length !== lastCount) {
      lastCount = d.comments.length;
      drawThread(d.post, d.comments);
      if (scroll) window.scrollTo(0, document.body.scrollHeight);
    }
  };
  const composer = h('form', { class: 'composer', onsubmit: async (e) => {
    e.preventDefault();
    if (!ta.value.trim()) return;
    sendBtn.disabled = true;
    try {
      await api('POST', `/api/posts/${id}/comments`, { body: ta.value, asAdmin: asAdminChk ? asAdminChk.checked : undefined });
      ta.value = '';
      ta.style.height = 'auto';
      await refresh(true);
    } catch (err) { handleError(err); }
    sendBtn.disabled = false;
  } },
  asAdminChk && h('label', { class: 'admin-chk', title: '운영자로 표시' }, asAdminChk, '🏫'),
  ta, sendBtn);

  render(thread, composer);
  // 새 답글 자동 확인 (10초마다)
  poller = setInterval(() => refresh(false).catch(() => {}), 10000);
}

function commentMenu(c, postId) {
  const admin = state.me.admin;
  sheet(c.isAdmin ? '운영자' : c.label, [
    { label: '📋 복사', run: () => navigator.clipboard?.writeText(c.body).then(() => toast('복사했어요.')) },
    !c.mine && { label: '🚨 신고하기', run: () => doReport('comments', c.id) },
    (c.mine || admin) && { label: '🗑 삭제', danger: true, run: async () => {
      if (!confirm('이 메시지를 삭제할까요?')) return;
      try { await api('DELETE', `/api/comments/${c.id}`); viewPost(postId); } catch (e) { handleError(e); }
    } },
    admin && { label: c.hidden ? '👁 숨김 해제' : '🙈 숨기기', run: () => adminCall(`/api/admin/comments/${c.id}/${c.hidden ? 'unhide' : 'hide'}`, () => viewPost(postId)) },
  ]);
}

async function adminCall(url, after) {
  try { await api('POST', url); after(); } catch (e) { handleError(e); }
}

async function doReport(kind, id) {
  const reason = prompt('신고 사유를 간단히 적어주세요.\n(예: 특정인 비방, 개인정보 노출, 광고)');
  if (reason === null) return;
  try {
    const r = await api('POST', `/api/${kind}/${id}/report`, { reason });
    toast(r.hidden ? '신고가 누적되어 숨김 처리되었습니다.' : '신고가 접수되었습니다. 감사합니다.');
  } catch (e) { handleError(e); }
}

// ---------- 화면: 새 대화 (글쓰기) ----------
function viewWrite() {
  setNav('write');
  topbar({ title: '새 이야기 시작하기' });
  const cats = Object.entries(state.me.categories).filter(([k]) => k !== 'notice' || state.me.admin);
  let category = state.category && state.category !== 'notice' ? state.category : 'free';
  const chips = h('div', { class: 'chips wrap' });
  const drawChips = () => chips.replaceChildren(...cats.map(([k, v]) =>
    h('button', { type: 'button', class: 'chip' + (category === k ? ' active' : ''), onclick: () => { category = k; drawChips(); } }, v)));
  drawChips();
  const title = h('input', { class: 'input', maxlength: 100, placeholder: '제목 (예: 방과후 신청 언제까지인가요?)' });
  const body = h('textarea', { class: 'input', rows: 8, maxlength: 5000, placeholder: '내용을 입력하세요.\n\n아이 이름·반·연락처 등 개인을 특정할 수 있는 정보는 적지 않는 것을 권장해요.' });
  const asAdminChk = state.me.admin && h('input', { type: 'checkbox', checked: true });
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/posts', { category, title: title.value, body: body.value, asAdmin: asAdminChk ? asAdminChk.checked : undefined });
      toast('등록되었습니다.');
      location.hash = `#/post/${r.id}`;
    } catch (err) { handleError(err); }
  };
  render(h('form', { class: 'panel write', onsubmit: submit },
    h('div', { class: 'field-label' }, '말머리'), chips,
    h('div', { class: 'field-label' }, '제목'), title,
    h('div', { class: 'field-label' }, '내용'), body,
    asAdminChk && h('label', { class: 'chk' }, asAdminChk, ' 운영자로 표시'),
    h('p', { class: 'notice-box' }, '🎭 닉네임은 글마다 무작위로 정해지며, 학교·운영자도 작성자를 알 수 없어요. 비방·욕설·허위사실은 신고 시 숨김 처리됩니다.'),
    h('button', { class: 'btn primary block' }, '등록하기'),
  ));
}

// ---------- 화면: 더보기 (이용수칙 · 홈화면 추가 · 운영자) ----------
async function viewMore() {
  setNav('more');
  topbar({ title: '더보기' });
  const sections = [
    h('section', { class: 'panel' },
      h('h3', {}, '📋 이용 수칙'),
      h('ol', { class: 'rules' },
        h('li', {}, '서로 존중하는 말투를 사용해주세요.'),
        h('li', {}, '특정 학생·교사·학부모를 비방하거나 알아볼 수 있게 쓰지 말아주세요.'),
        h('li', {}, '광고·홍보·정치·종교 글은 삭제될 수 있어요.'),
        h('li', {}, '신고가 3회 쌓이면 자동으로 숨겨지고 운영자가 검토해요.'),
      )),
    h('section', { class: 'panel' },
      h('h3', {}, '📱 앱처럼 쓰기'),
      h('p', {}, '아이폰: 사파리 하단 공유 버튼 → ', h('b', {}, '홈 화면에 추가')),
      h('p', {}, '안드로이드: 크롬 ⋮ 메뉴 → ', h('b', {}, '홈 화면에 추가'))),
  ];

  if (!state.me.admin) {
    const pw = h('input', { type: 'password', class: 'input', placeholder: '운영자 비밀번호' });
    sections.push(h('form', { class: 'panel', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', '/api/admin/login', { password: pw.value }); await loadMe(); toast('운영자로 로그인했습니다.'); route(); }
      catch (err) { toast(err.message); }
    } },
    h('h3', {}, '🏫 운영자 로그인'),
    h('p', { class: 'muted small' }, '선생님 또는 학부모회 운영진 전용입니다.'),
    h('div', { class: 'inline' }, pw, h('button', { class: 'btn primary' }, '로그인'))));
    render(...sections);
    return;
  }

  let stats, reports;
  try { [stats, reports] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/reports')]); }
  catch (e) { handleError(e); return; }
  const max = Math.max(1, ...stats.byCategory.map((x) => x.n));

  render(
    h('section', { class: 'panel' },
      h('div', { class: 'row' }, h('h3', {}, '📊 운영 현황 (최근 7일)'),
        h('button', { class: 'btn small', onclick: async () => { await api('POST', '/api/admin/logout'); await loadMe(); route(); } }, '로그아웃')),
      h('div', { class: 'stats' }, stat('누적 글', stats.total), stat('이번 주 글', stats.week), stat('이번 주 답글', stats.weekComments)),
      h('h4', {}, '말머리별'),
      stats.byCategory.length ? stats.byCategory.map((c) =>
        h('div', { class: 'bar-row' }, h('span', {}, c.name), h('div', { class: 'bar' }, h('i', { style: `width:${(c.n / max) * 100}%` })), h('b', {}, c.n)))
        : h('p', { class: 'muted small' }, '데이터 없음'),
      h('h4', {}, '관심 많은 글 TOP 5'),
      h('ol', { class: 'top' }, stats.top.map((t) => h('li', {}, h('a', { href: `#/post/${t.id}` }, `[${t.category}] ${t.title}`), h('span', { class: 'muted' }, ` ♥${t.likes} 💬${t.comments}`))))),
    h('section', { class: 'panel' },
      h('h3', {}, `🚨 신고·숨김 글 (${reports.posts.length})`),
      reports.posts.length ? h('ul', { class: 'room-list flat' }, reports.posts.map((p) => [roomItem(p), p.reasons.length > 0 && h('li', { class: 'reasons' }, '사유: ' + p.reasons.join(' / '))])) : h('p', { class: 'muted small' }, '없음'),
      h('h3', {}, `🚨 신고·숨김 답글 (${reports.comments.length})`),
      reports.comments.length ? reports.comments.map((c) => h('div', { class: 'report-item' + (c.hidden ? ' is-hidden' : '') },
        h('div', { class: 'meta' }, h('a', { href: `#/post/${c.postId}` }, `대화방 #${c.postId} ›`), h('span', {}, c.label), h('span', { class: 'warn-text' }, `신고 ${c.reports}`), c.hidden && h('span', { class: 'tag warn' }, '숨김')),
        h('div', { class: 'text' }, c.body),
        c.reasons.length > 0 && h('div', { class: 'reasons' }, '사유: ' + c.reasons.join(' / ')),
        h('button', { class: 'btn small', onclick: () => adminCall(`/api/admin/comments/${c.id}/${c.hidden ? 'unhide' : 'hide'}`, viewMore) }, c.hidden ? '숨김 해제' : '숨기기'))) : h('p', { class: 'muted small' }, '없음')),
    ...sections,
  );
}

const stat = (label, n) => h('div', { class: 'stat' }, h('b', {}, n), h('span', {}, label));

// ---------- 테마 · 라우터 ----------
function applyTheme() {
  const c = state.me.themeColor || '#d7263a';
  document.documentElement.style.setProperty('--brand', c);
  document.title = state.me.schoolName;
}

async function loadMe() {
  state.me = await api('GET', '/api/me');
  applyTheme();
}

function route() {
  clearInterval(poller);
  document.getElementById('sheet').classList.add('hidden');
  const hash = location.hash || '#/';
  if (!state.me.entered && hash !== '#/more') return viewEnter();
  $top.classList.remove('hidden');
  let m;
  if ((m = hash.match(/^#\/post\/(\d+)/))) return viewPost(m[1]);
  if (hash === '#/write') return viewWrite();
  if (hash === '#/notice') return viewList('notice');
  if (hash === '#/mine') return viewList('mine');
  if (hash === '#/more' || hash === '#/admin') return viewMore();
  return viewList('home');
}

window.addEventListener('hashchange', route);
loadMe().then(route).catch(() => render(h('p', { class: 'panel' }, '서버에 연결할 수 없습니다.')));
