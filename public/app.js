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

// 글 속 http(s) 주소를 눌러 열 수 있는 링크로 (텍스트로만 삽입하므로 안전)
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(/https?:\/\/[^\s<>"']+/g)) {
    out.push(text.slice(last, m.index));
    const url = m[0].replace(/[).,]+$/, '');
    out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'auto-link', onclick: (e) => e.stopPropagation() }, url));
    last = m.index + url.length;
  }
  out.push(text.slice(last));
  return out;
}

function avatar(content, cls = '') {
  return h('div', { class: 'avatar ' + cls }, content);
}

function render(...nodes) {
  $app.replaceChildren(...nodes.flat().filter(Boolean));
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
  setNav(mode === 'mine' ? 'more' : mode);
  const cats = state.me.categories;
  const titles = { home: null, notice: '공지사항', mine: '내 활동' };
  const searchToggle = mode === 'home' && h('button', { class: 'icon-btn', 'aria-label': '검색', onclick: () => { state.showSearch = !state.showSearch; viewList(mode); } }, '🔍');
  topbar({ title: titles[mode], back: mode === 'mine', right: searchToggle });

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
  if (mode === 'notice') parts.push(schoolNewsSection());

  const pinnedBox = h('div', {});
  const list = h('ul', { class: 'room-list' }, h('li', { class: 'empty' }, '불러오는 중…'));
  const more = h('div', { class: 'center' });
  const newsBanner = h('div', {});
  const eventStrip = h('div', {});
  if (mode === 'home' && !state.q) parts.unshift(eventStrip);
  render(...parts, newsBanner, pinnedBox, mode === 'notice' && h('div', { class: 'section-title' }, '📢 소통방 공지'), list, more);
  if (mode === 'home' && !state.q) { recentNewsBanner(newsBanner); upcomingStrip(eventStrip); }

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
      if (mode === 'home' && page === 1 && !state.q && data.posts.length && state.me.promoEnabled) insertPromo(list);
      more.replaceChildren(data.hasMore ? h('button', { class: 'btn', onclick: () => { page++; load(); } }, '더 보기') : '');
    } catch (e) { handleError(e); }
  };
  load();
}

// ---------- 학사일정 ----------
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400_000);
const WD = '일월화수목금토';
function fmtDay(d, withWd = true) {
  const t = new Date(d + 'T00:00:00Z');
  return `${t.getUTCMonth() + 1}.${t.getUTCDate()}${withWd ? `(${WD[t.getUTCDay()]})` : ''}`;
}
function fmtRange(e) { return e.start === e.end ? fmtDay(e.start) : `${fmtDay(e.start)} ~ ${fmtDay(e.end)}`; }
function dday(e) {
  const t = kstToday();
  if (e.start <= t && t <= e.end) return { text: '진행 중', cls: 'now' };
  const n = dayDiff(t, e.start);
  if (n < 0) return { text: '지남', cls: 'past' };
  return { text: n === 0 ? 'D-DAY' : `D-${n}`, cls: n <= 3 ? 'soon' : '' };
}
const gradeTag = (e) => e.grades && h('span', { class: 'tag grade' }, e.grades.split(',').join('·') + '학년');

async function upcomingStrip(box) {
  try {
    const { events } = await api('GET', '/api/events/upcoming?limit=6');
    if (!events.length) return;
    box.replaceChildren(h('div', { class: 'ev-strip' },
      h('a', { class: 'ev-strip-head', href: '#/calendar' }, h('b', {}, '📅 다가오는 일정'), h('span', {}, '전체 ›')),
      h('div', { class: 'ev-cards' }, events.map((e) => {
        const dd = dday(e);
        return h('a', { class: 'ev-card' + (e.holiday ? ' holiday' : ''), href: `#/calendar/${e.start.slice(0, 7)}/${e.start}` },
          h('span', { class: 'dday ' + dd.cls }, dd.text),
          h('span', { class: 'ev-card-date' }, fmtRange(e)),
          h('span', { class: 'ev-card-title' }, e.title),
          gradeTag(e));
      }))));
  } catch { /* 무시 */ }
}

function eventRow(e) {
  const dd = dday(e);
  return h('li', { class: 'ev-row' + (e.holiday ? ' holiday' : '') + (dd.cls === 'past' ? ' past' : '') },
    h('div', { class: 'ev-date' }, h('b', {}, fmtDay(e.start, false)), h('span', {}, WD[new Date(e.start + 'T00:00:00Z').getUTCDay()]),
      e.end !== e.start && h('em', {}, `~${fmtDay(e.end, false)}`)),
    h('div', { class: 'ev-main' },
      h('div', { class: 'ev-title' }, e.title),
      h('div', { class: 'ev-tags' },
        h('span', { class: 'dday ' + dd.cls }, dd.text),
        e.holiday && h('span', { class: 'tag warn' }, '휴업일'),
        gradeTag(e),
        h('span', { class: 'tag src' }, e.source === 'neis' ? '학교(나이스)' : '운영진 등록')),
      e.detail && h('div', { class: 'ev-detail' }, e.detail)),
    h('div', { class: 'ev-actions' },
      h('a', { class: 'ev-btn', href: `/api/events/${e.id}/ics`, title: '내 휴대폰 캘린더에 추가', 'aria-label': '캘린더에 추가' }, '＋📅'),
      h('button', { class: 'ev-btn', title: '이 일정으로 이야기 나누기', onclick: () => {
        state.prefill = { category: 'question', title: `[일정] ${e.title} (${fmtRange(e)})`.slice(0, 100), body: '' };
        location.hash = '#/write';
      } }, '💬')));
}

async function viewCalendar(month, selected) {
  setNav('calendar');
  topbar({ title: '학사 일정' });
  const today = kstToday();
  month = /^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${month}-${String(days).padStart(2, '0')}`;
  const shift = (n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

  let events = [];
  try { ({ events } = await api('GET', `/api/events?from=${first}&to=${last}`)); } catch (e) { handleError(e); return; }

  // 날짜별 일정 표시
  const byDay = {};
  for (const e of events) for (let d = e.start < first ? first : e.start; d <= e.end && d <= last; d = addDay(d)) (byDay[d] ||= []).push(e);

  const lead = new Date(first + 'T00:00:00Z').getUTCDay();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'cal-cell empty' }));
  for (let i = 1; i <= days; i++) {
    const d = `${month}-${String(i).padStart(2, '0')}`;
    const evs = byDay[d] || [];
    const wd = (lead + i - 1) % 7;
    cells.push(h('button', {
      class: 'cal-cell' + (d === today ? ' today' : '') + (d === selected ? ' sel' : '') + (wd === 0 || evs.some((e) => e.holiday) ? ' red' : wd === 6 ? ' blue' : ''),
      onclick: () => { location.hash = d === selected ? `#/calendar/${month}` : `#/calendar/${month}/${d}`; },
    }, h('span', { class: 'cal-num' }, i), evs.length > 0 && h('span', { class: 'cal-dots' }, evs.slice(0, 3).map((e) => h('i', { class: e.holiday ? 'h' : e.source === 'manual' ? 'm' : '' })))));
  }

  const shown = selected ? (byDay[selected] || []) : events;
  const listTitle = selected ? `${fmtDay(selected)} 일정` : `${m}월 일정 ${events.length}건`;

  render(
    h('section', { class: 'cal' },
      h('div', { class: 'cal-head' },
        h('a', { class: 'icon-btn', href: `#/calendar/${shift(-1)}`, 'aria-label': '이전 달' }, '‹'),
        h('b', {}, `${y}년 ${m}월`),
        h('a', { class: 'icon-btn', href: `#/calendar/${shift(1)}`, 'aria-label': '다음 달' }, '›'),
        month !== today.slice(0, 7) && h('a', { class: 'chip small', href: '#/calendar' }, '오늘')),
      h('div', { class: 'cal-grid wd' }, [...WD].map((w, i) => h('div', { class: 'cal-wd' + (i === 0 ? ' red' : i === 6 ? ' blue' : '') }, w))),
      h('div', { class: 'cal-grid' }, cells),
      h('div', { class: 'cal-legend' }, h('span', {}, h('i', { class: 'h' }), '휴업·방학'), h('span', {}, h('i', {}), '학교 일정'), h('span', {}, h('i', { class: 'm' }), '운영진 등록'))),
    h('div', { class: 'section-title' }, listTitle),
    shown.length ? h('ul', { class: 'ev-list' }, shown.map(eventRow)) : h('p', { class: 'hint center' }, selected ? '이 날은 등록된 일정이 없어요.' : '이 달에는 등록된 일정이 없어요.'),
    h('p', { class: 'hint' }, '학교가 나이스(NEIS)에 등록한 학사일정이 자동으로 반영돼요. ＋📅 를 누르면 내 휴대폰 캘린더에 추가돼요.'),
  );
}
const addDay = (d) => new Date(new Date(d + 'T00:00:00Z').getTime() + 86400_000).toISOString().slice(0, 10);

async function calendarAdminPanel() {
  const panel = h('section', { class: 'panel' });
  const load = async () => {
    let d;
    try { d = await api('GET', '/api/admin/calendar'); } catch (e) { handleError(e); return; }
    const st = d.status || {};
    const key = h('input', { class: 'input', placeholder: d.config.hasKey ? `등록됨 (${d.config.keyHint}) · 바꾸려면 새 키 입력` : '나이스 인증키 (선택, 없어도 동작)' });
    const q = h('input', { class: 'input', placeholder: '학교 이름 검색 (예: 동탄국제)' });
    const results = h('div', { class: 'school-results' });
    const start = h('input', { class: 'input', type: 'date' });
    const end = h('input', { class: 'input', type: 'date' });
    const title = h('input', { class: 'input', maxlength: 60, placeholder: '일정 이름 (예: 2학기 기말고사)' });
    const detail = h('input', { class: 'input', maxlength: 200, placeholder: '설명 (선택)' });
    const gradeChks = ['1', '2', '3'].map((g) => h('input', { type: 'checkbox', value: g }));
    const saveCfg = async (extra) => {
      try { await api('POST', '/api/admin/calendar/config', extra); toast('저장했습니다. 일정을 가져오는 중…'); await api('POST', '/api/admin/calendar/sync'); load(); }
      catch (e) { toast(e.message); }
    };
    panel.replaceChildren(...[
      h('h3', {}, '📅 학사일정'),
      h('p', { class: 'small' }, h('b', {}, d.config.schoolName || '학교 미설정'), h('span', { class: 'muted' }, ` · 교육청 ${d.config.office || '-'} / 학교코드 ${d.config.school || '-'}`)),
      st.at && h('p', { class: 'small ' + (st.ok ? 'ok-text' : 'warn-text') },
        st.ok ? `✓ 나이스 연동됨 · ${new Date(st.at).toLocaleString('ko-KR')} · 일정 ${st.count}건 (${st.mode})` : `✕ 실패 · ${new Date(st.at).toLocaleString('ko-KR')} · ${st.error}`),
      h('div', { class: 'actions' }, h('button', { class: 'btn small', onclick: async () => { toast('가져오는 중…'); await api('POST', '/api/admin/calendar/sync'); load(); } }, '지금 다시 가져오기')),
      h('details', {}, h('summary', {}, '연동 설정 (학교 변경 · 인증키)'),
        h('div', { class: 'promo-form' },
          h('div', { class: 'inline' }, q, h('button', { class: 'btn small', onclick: async () => {
            try {
              const r = await api('GET', '/api/admin/calendar/search?q=' + encodeURIComponent(q.value));
              results.replaceChildren(...(r.schools.length ? r.schools.map((sc) => h('button', { class: 'school-pick', onclick: () => saveCfg({ office: sc.office, school: sc.code, schoolName: sc.name }) },
                h('b', {}, sc.name), h('span', {}, `${sc.officeName} · ${sc.address}`))) : [h('p', { class: 'muted small' }, '검색 결과가 없어요.')]));
            } catch (e) { toast(e.message); }
          } }, '검색')),
          results,
          h('p', { class: 'muted small' }, '인증키가 없으면 여러 번 나눠 조회합니다(느리지만 동작). open.neis.go.kr 에서 무료로 발급받아 넣으면 한 번에 가져옵니다.'),
          h('div', { class: 'inline' }, key, h('button', { class: 'btn small', onclick: () => saveCfg({ key: key.value }) }, '키 저장')))),
      h('h4', {}, '직접 등록한 일정'),
      h('p', { class: 'muted small' }, '나이스에 없는 시험·설명회·학부모회 행사 등을 추가하세요.'),
      h('form', { class: 'promo-form', onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/admin/events', { start: start.value, end: end.value || start.value, title: title.value, detail: detail.value, grades: gradeChks.filter((c) => c.checked).map((c) => c.value).join(',') });
          toast('일정을 추가했습니다.');
          load();
        } catch (err) { toast(err.message); }
      } },
      h('div', { class: 'inline' }, h('label', { class: 'mini' }, '시작일', start), h('label', { class: 'mini' }, '종료일(선택)', end)),
      title, detail,
      h('div', { class: 'grade-chks' }, h('span', { class: 'muted small' }, '대상 학년 (선택 안 하면 전체)'), gradeChks.map((c) => h('label', { class: 'chk' }, c, ` ${c.value}학년`))),
      h('button', { class: 'btn primary' }, '일정 추가')),
      d.manual.length > 0 && h('ul', { class: 'ev-list compact' }, d.manual.map((e) => h('li', { class: 'ev-admin' },
        h('span', {}, `${fmtRange(e)} · ${e.title}${e.grades ? ` (${e.grades}학년)` : ''}`),
        h('button', { class: 'link danger', onclick: async () => {
          if (!confirm(`「${e.title}」 일정을 삭제할까요?`)) return;
          try { await api('DELETE', `/api/admin/events/${e.id}`); load(); } catch (err) { handleError(err); }
        } }, '삭제')))),
    ].filter(Boolean));
  };
  load();
  return panel;
}

// ---------- 학교 홈페이지 소식 (공지사항 · 가정통신문) ----------
const isNew = (it) => it.date && Date.now() - new Date(it.date + 'T00:00:00+09:00').getTime() < 3 * 86400_000;
const shortDate = (d) => (d ? d.slice(2).replace(/-/g, '.') : '');

function newsItem(it) {
  return h('li', { class: 'news-item' },
    h('a', { class: 'news-link', href: it.url, target: '_blank', rel: 'noopener noreferrer' },
      h('div', { class: 'news-top' },
        h('span', { class: 'tag news-src' }, it.source),
        isNew(it) && h('span', { class: 'tag new' }, 'N'),
        h('span', { class: 'news-date' }, shortDate(it.date))),
      h('div', { class: 'news-title' }, it.title)),
    h('button', { class: 'news-talk', title: '이 소식으로 이야기 나누기', onclick: () => {
      state.prefill = { category: 'question', title: (it.title.includes(it.source) ? it.title : `[${it.source}] ${it.title}`).slice(0, 100), body: `학교 홈페이지 원문: ${it.url}\n\n` };
      location.hash = '#/write';
    } }, '💬'));
}

function schoolNewsSection() {
  const box = h('section', { class: 'news-box' }, h('div', { class: 'section-title' }, '🏫 학교 홈페이지 소식'), h('p', { class: 'hint' }, '불러오는 중…'));
  let source = '';
  const load = async () => {
    let d;
    try { d = await api('GET', '/api/news?limit=15' + (source ? '&source=' + encodeURIComponent(source) : '')); } catch (e) { handleError(e); return; }
    if (!d.sources.length) { box.replaceChildren(); return; }
    box.replaceChildren(
      h('div', { class: 'section-title' }, '🏫 학교 홈페이지 소식'),
      d.sources.length > 1 && h('div', { class: 'chips' }, [['', '전체'], ...d.sources.map((x) => [x, x])].map(([k, v]) =>
        h('button', { class: 'chip' + (source === k ? ' active' : ''), onclick: () => { source = k; load(); } }, v))),
      d.items.length ? h('ul', { class: 'news-list' }, d.items.map(newsItem)) : h('p', { class: 'hint' }, '아직 가져온 소식이 없어요.'),
      h('p', { class: 'hint' }, '제목을 누르면 학교 홈페이지 원문이 열려요. 💬를 누르면 학부모끼리 이야기를 나눌 수 있어요.'),
    );
  };
  load();
  return box;
}

async function recentNewsBanner(box) {
  try {
    const d = await api('GET', '/api/news?limit=5');
    const fresh = d.items.filter(isNew);
    if (!fresh.length) return;
    box.replaceChildren(h('a', { class: 'pin-banner news-banner', href: '#/notice' },
      h('b', {}, '📄'), h('span', {}, `[${fresh[0].source}] ${fresh[0].title}`), fresh.length > 1 && h('em', {}, `+${fresh.length - 1}`), h('i', {}, '›')));
  } catch { /* 무시 */ }
}

async function newsAdminPanel() {
  const panel = h('section', { class: 'panel' });
  const load = async () => {
    let d;
    try { d = await api('GET', '/api/admin/news'); } catch (e) { handleError(e); return; }
    const rows = h('div', { class: 'news-src-rows' });
    const addRow = (src = { name: '', url: '' }) => {
      const st = d.status[src.name];
      rows.append(h('div', { class: 'news-src-row' },
        h('div', { class: 'inline' },
          h('input', { class: 'input name', placeholder: '이름 (예: 가정통신문)', value: src.name, maxlength: 20 }),
          h('button', { type: 'button', class: 'btn small', onclick: (e) => e.target.closest('.news-src-row').remove() }, '삭제')),
        h('input', { class: 'input url', type: 'url', placeholder: 'https://www.dtg.hs.kr/sys/bbs/board.php?bo_table=...', value: src.url }),
        st && h('div', { class: 'small ' + (st.ok ? 'ok-text' : 'warn-text') },
          st.ok ? `✓ 연결됨 · ${new Date(st.at).toLocaleString('ko-KR')} · 글 ${st.count}개 (${st.via === 'rss' ? 'RSS' : '목록'})` : `✕ 실패 · ${new Date(st.at).toLocaleString('ko-KR')} · ${st.error}`)));
    };
    (d.sources.length ? d.sources : [{ name: '공지사항', url: '' }, { name: '가정통신문', url: '' }]).forEach(addRow);
    const collect = () => [...rows.querySelectorAll('.news-src-row')].map((r) => ({ name: r.querySelector('.name').value, url: r.querySelector('.url').value }));
    panel.replaceChildren(
      h('h3', {}, '🔗 학교 홈페이지 연동'),
      h('p', { class: 'muted small' }, '학교 홈페이지에서 공지사항·가정통신문 게시판을 열고, 주소창의 주소를 그대로 붙여넣으세요. 30분마다 제목과 링크만 가져옵니다.'),
      rows,
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => addRow() }, '+ 게시판 추가'),
        h('button', { class: 'btn small primary', onclick: async () => {
          try {
            await api('POST', '/api/admin/news/sources', { sources: collect() });
            toast('저장했습니다. 가져오는 중…');
            await api('POST', '/api/admin/news/refresh');
            load();
          } catch (e) { toast(e.message); }
        } }, '저장 후 가져오기')),
    );
  };
  load();
  return panel;
}

// ---------- 공익 정보 · 제휴 ----------
const PROMO_PRINCIPLES = [
  ['공익 정보가 먼저', () => `목록 정보칸 노출의 ${Math.round(state.me.publicFirstRatio * 100)}% 이상은 학교·교육청·도서관·청소년 상담·지역 행사 같은 공익 정보로 채웁니다.`],
  ['제휴는 표시하고 심사', () => '학원·업체 제휴는 운영자 심사 후에만 실리며, 항상 「제휴」 표시와 광고주 이름을 밝힙니다.'],
  ['대화는 광고 없이', () => '글과 댓글(대화방) 안에는 광고를 넣지 않습니다. 목록 중간 한 칸이 전부입니다.'],
  ['싣지 않는 광고', () => '선행학습·불안 조장, 합격 보장 등 과장, 개인정보 수집, 특정 교사·학교 비방, 고액 컨설팅 유도 광고는 받지 않습니다.'],
  ['개인 추적 없음', () => '노출·클릭은 합계로만 집계하며 누가 보았는지는 기록하지 않습니다.'],
  ['수익은 공익에', () => '제휴 수익은 학부모회 공익 활동(장학·행사 등)에 쓰고 사용 내역을 공지합니다.'],
];

function promoCard(p, { compact = false } = {}) {
  const inner = [
    h('div', { class: 'promo-head' },
      h('span', { class: `tag promo-${p.kind}` }, p.kindName),
      p.sponsor && h('span', { class: 'promo-sponsor' }, p.sponsor),
      compact && h('a', { href: '#/local', class: 'promo-why', onclick: (e) => e.stopPropagation() }, '운영 원칙 ⓘ')),
    h('div', { class: 'promo-title' }, p.title),
    p.body && h('div', { class: 'promo-body' }, p.body),
  ];
  const onclick = () => fetch(`/api/promos/${p.id}/click`, { method: 'POST', keepalive: true }).catch(() => {});
  return p.url
    ? h('a', { class: `promo promo-${p.kind}-card`, href: p.url, target: '_blank', rel: 'noopener noreferrer sponsored', onclick }, ...inner, h('span', { class: 'promo-go' }, '자세히 ›'))
    : h('div', { class: `promo promo-${p.kind}-card` }, ...inner);
}

async function insertPromo(list) {
  try {
    const { promo } = await api('GET', '/api/promos/slot');
    if (!promo) return;
    const li = h('li', { class: 'promo-slot' }, promoCard(promo, { compact: true }));
    const items = list.querySelectorAll('li.room');
    const after = items[Math.min(2, items.length - 1)];
    after.after(li);
  } catch { /* 정보칸 실패는 무시 */ }
}

async function viewLocal() {
  setNav('more');
  topbar({ title: '지역·교육 정보', back: true });
  let promos = [];
  try { ({ promos } = await api('GET', '/api/promos')); } catch (e) { handleError(e); return; }
  const pub = promos.filter((p) => p.kind === 'public');
  const spon = promos.filter((p) => p.kind === 'sponsor');
  render(
    h('section', { class: 'panel' },
      h('h3', {}, '🏫 공익 정보'),
      pub.length ? h('div', { class: 'promo-list' }, pub.map((p) => promoCard(p))) : h('p', { class: 'muted small' }, '등록된 공익 정보가 없어요.')),
    spon.length > 0 && h('section', { class: 'panel' },
      h('h3', {}, '🤝 제휴 소식'),
      h('p', { class: 'muted small' }, '운영자 심사를 거친 제휴 정보입니다. 이용 여부는 각 가정에서 판단해주세요.'),
      h('div', { class: 'promo-list' }, spon.map((p) => promoCard(p)))),
    principlesPanel(),
  );
}

function principlesPanel() {
  return h('section', { class: 'panel' },
    h('h3', {}, '⚖️ 광고·제휴 운영 원칙'),
    h('ol', { class: 'principles' }, PROMO_PRINCIPLES.map(([t, d]) => h('li', {}, h('b', {}, t), h('span', {}, d())))),
    h('p', { class: 'muted small' }, '제휴 문의나 부적절한 광고 제보는 운영진에게 알려주세요.'));
}

async function promoAdminPanel() {
  const panel = h('section', { class: 'panel' }, h('h3', {}, '🤝 공익 정보 · 제휴 관리'), h('p', { class: 'muted small' }, '불러오는 중…'));
  const load = async () => {
    let d;
    try { d = await api('GET', '/api/admin/promos'); } catch (e) { handleError(e); return; }
    const totalImp = d.impressions.public + d.impressions.sponsor;
    const share = totalImp ? Math.round((d.impressions.public / totalImp) * 100) : 100;
    const form = promoForm(null, load);
    panel.replaceChildren(...[
      h('div', { class: 'row' }, h('h3', {}, '🤝 공익 정보 · 제휴 관리'),
        h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: d.enabled, onchange: async (e) => {
          try { await api('POST', '/api/admin/settings', { promoEnabled: e.target.checked }); await loadMe(); toast(e.target.checked ? '정보칸을 켰습니다.' : '정보칸을 껐습니다.'); load(); } catch (err) { handleError(err); }
        } }), h('span', {}, d.enabled ? '노출 중' : '꺼짐'))),
      h('div', { class: 'stats' },
        stat('공익 노출 비중', share + '%'),
        stat('최소 공익 비율', Math.round(d.publicFirstRatio * 100) + '%'),
        stat('누적 노출', totalImp)),
      share < d.publicFirstRatio * 100 && h('p', { class: 'warn-text small' }, '공익 정보 노출 비중이 기준보다 낮아요. 공익 정보를 더 등록해주세요.'),
      h('details', { class: 'promo-new' }, h('summary', {}, '+ 새로 등록'), form),
      d.promos.length ? h('div', { class: 'promo-admin-list' }, d.promos.map((p) => {
        const ctr = p.impressions ? ((p.clicks / p.impressions) * 100).toFixed(1) : '0.0';
        const period = [p.startsAt && new Date(p.startsAt).toLocaleDateString('ko-KR'), p.endsAt && new Date(p.endsAt).toLocaleDateString('ko-KR')].filter(Boolean).join(' ~ ');
        const box = h('div', { class: 'promo-admin' + (p.active ? '' : ' is-hidden') },
          promoCard(p),
          h('div', { class: 'meta' },
            h('span', {}, `노출 ${p.impressions}`), h('span', {}, `클릭 ${p.clicks}`), h('span', {}, `클릭률 ${ctr}%`),
            period && h('span', {}, `기간 ${period}`), !p.active && h('span', { class: 'tag warn' }, '중지')),
          h('div', { class: 'actions' },
            h('button', { class: 'btn small', onclick: () => box.replaceChildren(promoForm(p, load)) }, '수정'),
            h('button', { class: 'btn small', onclick: () => adminCall(`/api/admin/promos/${p.id}/${p.active ? 'off' : 'on'}`, load) }, p.active ? '중지' : '재개'),
            h('button', { class: 'btn small danger', onclick: async () => {
              if (!confirm('삭제할까요? 노출 통계도 함께 지워집니다.')) return;
              try { await api('DELETE', `/api/admin/promos/${p.id}`); load(); } catch (e) { handleError(e); }
            } }, '삭제')));
        return box;
      })) : h('p', { class: 'muted small' }, '아직 등록된 정보가 없어요. 공익 정보부터 등록해보세요.'),
    ].filter(Boolean));
  };
  load();
  return panel;
}

function promoForm(p, done) {
  const toDate = (ts) => (ts ? new Date(ts + 9 * 3600_000).toISOString().slice(0, 10) : '');
  const kind = h('select', { class: 'input' },
    h('option', { value: 'public', selected: !p || p.kind === 'public' }, '공익 정보 (학교·교육청·도서관·지역 행사 등)'),
    h('option', { value: 'sponsor', selected: p?.kind === 'sponsor' }, '제휴 (학원·업체, 광고주 표시 필수)'));
  const title = h('input', { class: 'input', maxlength: 40, placeholder: '제목 (40자)', value: p?.title || '' });
  const body = h('textarea', { class: 'input', rows: 2, maxlength: 120, placeholder: '한두 줄 설명 (120자)' });
  body.value = p?.body || '';
  const sponsor = h('input', { class: 'input', maxlength: 30, placeholder: '기관/광고주 이름', value: p?.sponsor || '' });
  const url = h('input', { class: 'input', type: 'url', placeholder: 'https:// 링크 (선택)', value: p?.url || '' });
  const startsAt = h('input', { class: 'input', type: 'date', value: toDate(p?.startsAt) });
  const endsAt = h('input', { class: 'input', type: 'date', value: toDate(p?.endsAt) });
  return h('form', { class: 'promo-form', onsubmit: async (e) => {
    e.preventDefault();
    const payload = { kind: kind.value, title: title.value, body: body.value, sponsor: sponsor.value, url: url.value, startsAt: startsAt.value, endsAt: endsAt.value, active: p ? p.active : true };
    try {
      await api(p ? 'PUT' : 'POST', p ? `/api/admin/promos/${p.id}` : '/api/admin/promos', payload);
      toast(p ? '수정했습니다.' : '등록했습니다.');
      done();
    } catch (err) { toast(err.message); }
  } },
  kind, title, body, sponsor, url,
  h('div', { class: 'inline' }, h('label', { class: 'mini' }, '시작', startsAt), h('label', { class: 'mini' }, '종료', endsAt)),
  h('p', { class: 'muted small' }, '제휴는 「운영 원칙」에 어긋나는 내용(선행학습·불안 조장, 합격 보장 등)을 싣지 않습니다.'),
  h('div', { class: 'actions' }, h('button', { class: 'btn primary' }, p ? '저장' : '등록'), p && h('button', { type: 'button', class: 'btn', onclick: done }, '취소')));
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
            h('div', { class: 'text' }, linkify(post.body)),
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
            h('div', { class: 'bubble' + (c.hidden ? ' is-hidden' : ''), onclick: () => commentMenu(c, id) }, h('div', { class: 'text' }, linkify(c.body))),
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
  const pre = state.prefill || {};
  state.prefill = null;
  let category = pre.category || (state.category && state.category !== 'notice' ? state.category : 'free');
  const chips = h('div', { class: 'chips wrap' });
  const drawChips = () => chips.replaceChildren(...cats.map(([k, v]) =>
    h('button', { type: 'button', class: 'chip' + (category === k ? ' active' : ''), onclick: () => { category = k; drawChips(); } }, v)));
  drawChips();
  const title = h('input', { class: 'input', maxlength: 100, placeholder: '제목 (예: 방과후 신청 언제까지인가요?)', value: pre.title || '' });
  const body = h('textarea', { class: 'input', rows: 8, maxlength: 5000, placeholder: '내용을 입력하세요.\n\n아이 이름·반·연락처 등 개인을 특정할 수 있는 정보는 적지 않는 것을 권장해요.' });
  body.value = pre.body || '';
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
    h('a', { class: 'panel link-panel', href: '#/mine' }, h('span', {}, '🙋 내 활동'), h('span', { class: 'muted small' }, '내가 쓴 글 · 댓글 단 대화 ›')),
    state.me.promoEnabled && h('a', { class: 'panel link-panel', href: '#/local' }, h('span', {}, '🏘 지역·교육 정보'), h('span', { class: 'muted small' }, '공익 정보 · 제휴 소식 ›')),
    h('section', { class: 'panel' },
      h('h3', {}, '📋 이용 수칙'),
      h('ol', { class: 'rules' },
        h('li', {}, '서로 존중하는 말투를 사용해주세요.'),
        h('li', {}, '특정 학생·교사·학부모를 비방하거나 알아볼 수 있게 쓰지 말아주세요.'),
        h('li', {}, '개인 광고·홍보·정치·종교 글은 삭제될 수 있어요. 제휴는 운영진 심사를 거쳐 「제휴」 표시로만 실립니다.'),
        h('li', {}, '신고가 3회 쌓이면 자동으로 숨겨지고 운영자가 검토해요.'),
      )),
    h('section', { class: 'panel' },
      h('h3', {}, '📱 앱처럼 쓰기'),
      h('p', {}, '아이폰: 사파리 하단 공유 버튼 → ', h('b', {}, '홈 화면에 추가')),
      h('p', {}, '안드로이드: 크롬 ⋮ 메뉴 → ', h('b', {}, '홈 화면에 추가'))),
    principlesPanel(),
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
    await calendarAdminPanel(),
    await newsAdminPanel(),
    await promoAdminPanel(),
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
  if (hash === '#/local') return viewLocal();
  if ((m = hash.match(/^#\/calendar(?:\/(\d{4}-\d{2}))?(?:\/(\d{4}-\d{2}-\d{2}))?$/))) return viewCalendar(m[1], m[2]);
  return viewList('home');
}

window.addEventListener('hashchange', route);
loadMe().then(route).catch(() => render(h('p', { class: 'panel' }, '서버에 연결할 수 없습니다.')));
