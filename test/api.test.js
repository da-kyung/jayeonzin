'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
process.env.DATA_DIR = dir;
process.env.ACCESS_CODE = '2468';
process.env.ADMIN_PASSWORD = 'teacher!';
const { server, sanitizeText } = require('../server.js');
let base;

before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let jar = {};
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    return { status: res.status, data: await res.json() };
  };
}

test('개인정보·비속어 자동 가림', () => {
  assert.match(sanitizeText('연락주세요 010-1234-5678'), /\[전화번호 가림\]/);
  assert.match(sanitizeText('a.b@school.kr 로'), /\[이메일 가림\]/);
  assert.equal(sanitizeText('씨발'), '**');
});

test('입장 코드 없이는 접근 불가, 틀린 코드 거부', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/posts')).status, 401);
  assert.equal((await c('POST', '/api/enter', { code: '0000' })).status, 401);
  assert.equal((await c('POST', '/api/enter', { code: '2468' })).status, 200);
  assert.equal((await c('GET', '/api/posts')).status, 200);
});

test('익명 글/댓글 흐름, 라벨, 공감, 신고 자동숨김, 운영자', async () => {
  const a = client(), b = client(), c = client(), d = client(), adm = client();
  for (const x of [a, b, c, d]) await x('POST', '/api/enter', { code: '2468' });

  assert.equal((await a('POST', '/api/posts', { category: 'notice', title: '공지', body: '일반인 공지 불가' })).status, 403);
  const { data: { id } } = await a('POST', '/api/posts', { category: 'question', title: '급식 질문', body: '급식 메뉴 문의드려요' });

  await b('POST', `/api/posts/${id}/comments`, { body: '저도 궁금해요' });
  await a('POST', `/api/posts/${id}/comments`, { body: '감사합니다' });
  await c('POST', `/api/posts/${id}/comments`, { body: '저는 셋째' });
  await b('POST', `/api/posts/${id}/comments`, { body: '다시 b' });
  const view = (await b('GET', `/api/posts/${id}`)).data;
  assert.deepEqual(view.comments.map((x) => x.label), ['익명1', '글쓴이', '익명2', '익명1']);
  assert.ok(!JSON.stringify(view).includes('author_hash'));
  assert.equal(view.post.mine, false);

  assert.equal((await b('POST', `/api/posts/${id}/like`)).data.likes, 1);
  assert.equal((await b('POST', `/api/posts/${id}/like`)).data.likes, 0);

  assert.equal((await b('DELETE', `/api/posts/${id}`)).status, 403);
  assert.equal((await a('POST', `/api/posts/${id}/report`, {})).status, 400);
  await b('POST', `/api/posts/${id}/report`, { reason: '테스트' });
  assert.equal((await b('POST', `/api/posts/${id}/report`, {})).status, 409);
  await c('POST', `/api/posts/${id}/report`, {});
  const r = await d('POST', `/api/posts/${id}/report`, {});
  assert.equal(r.data.hidden, true);
  assert.match((await d('GET', `/api/posts/${id}`)).data.post.title, /숨겨진/);

  assert.equal((await adm('POST', '/api/admin/login', { password: 'no' })).status, 401);
  assert.equal((await adm('POST', '/api/admin/login', { password: 'teacher!' })).status, 200);
  const rep = (await adm('GET', '/api/admin/reports')).data;
  assert.equal(rep.posts[0].reports, 3);
  assert.deepEqual(rep.posts[0].reasons, ['테스트']);
  await adm('POST', `/api/admin/posts/${id}/unhide`);
  assert.equal((await d('GET', `/api/posts/${id}`)).data.post.title, '급식 질문');

  const n = await adm('POST', '/api/posts', { category: 'notice', title: '운영 공지', body: '서로 존중해주세요' });
  await adm('POST', `/api/admin/posts/${n.data.id}/pin`);
  const list = (await a('GET', '/api/posts')).data.posts;
  assert.equal(list[0].nickname, '운영자');
  assert.equal(list[0].pinned, true);
  assert.equal((await a('GET', '/api/admin/stats')).status, 403);

  assert.equal((await a('DELETE', `/api/posts/${id}`)).status, 200);
});

test('공익 정보·제휴: 운영자만 등록, 공익 우선 노출, 끄기', async () => {
  const u = client(), adm = client();
  await u('POST', '/api/enter', { code: '2468' });
  await adm('POST', '/api/admin/login', { password: 'teacher!' });

  assert.equal((await u('POST', '/api/admin/promos', { kind: 'public', title: '도서관 행사' })).status, 403);
  assert.equal((await adm('POST', '/api/admin/promos', { kind: 'sponsor', title: '수학학원' })).status, 400, '광고주 필수');
  assert.equal((await adm('POST', '/api/admin/promos', { kind: 'public', title: '링크', url: 'javascript:alert(1)' })).status, 400);
  await adm('POST', '/api/admin/promos', { kind: 'public', title: '시립도서관 진로 특강', sponsor: '화성시립도서관', url: 'https://example.org' });
  await adm('POST', '/api/admin/promos', { kind: 'sponsor', title: '여름 특강 안내', sponsor: 'OO학원' });

  const kinds = { public: 0, sponsor: 0 };
  for (let i = 0; i < 60; i++) kinds[(await u('GET', '/api/promos/slot')).data.promo.kind]++;
  assert.ok(kinds.public / 60 >= 0.6, `공익 비중 ${kinds.public}/60`);
  assert.ok(kinds.sponsor > 0);

  const list = (await u('GET', '/api/promos')).data.promos;
  assert.equal(list[0].kind, 'public');
  assert.equal(list[0].impressions, undefined, '일반 사용자에겐 통계 비공개');

  await u('POST', `/api/promos/${list[0].id}/click`);
  await u('POST', `/api/promos/${list[0].id}/click`);
  const ad = (await adm('GET', '/api/admin/promos')).data;
  assert.equal(ad.promos.find((p) => p.id === list[0].id).clicks, 1, '같은 사람 중복 클릭은 1회');

  await adm('POST', '/api/admin/settings', { promoEnabled: false });
  assert.equal((await u('GET', '/api/promos/slot')).data.promo, null);
  assert.equal((await u('GET', '/api/me')).data.promoEnabled, false);
});

test('학교 홈페이지 연동: 목록 HTML · RSS에서 제목/날짜/링크 가져오기', async () => {
  const http = require('node:http');
  const listHtml = `<html><head><meta charset="utf-8"></head><body><table>
    <tr class="bo_notice"><td class="td_subject"><a href="/sys/bbs/board.php?bo_table=notice&amp;wr_id=120&amp;page=1">공지 2025학년도 겨울방학 방과후학교 안내</a></td><td class="td_datetime">2025-11-10</td></tr>
    <tr><td><a href="./board.php?bo_table=notice&wr_id=118">  2학년 선택과목 설명회 개최 안내 <span>새글</span></a> <a href="./board.php?bo_table=notice&wr_id=118#c_5">[3]</a></td><td>25-11-07</td></tr>
    <tr><td><a href="./board.php?bo_table=other&wr_id=999">다른 게시판 글</a></td><td>25-11-01</td></tr>
    <tr><td><a href="./board.php?bo_table=notice&page=2">2</a></td></tr>
  </table></body></html>`;
  const rss = `<?xml version="1.0" encoding="utf-8"?><rss><channel>
    <item><title><![CDATA[가정통신문 제2025-88호 수학여행 동의서]]></title><link>https://school.example/sys/bbs/board.php?bo_table=letters&amp;wr_id=88</link><pubDate>Wed, 12 Nov 2025 01:00:00 +0000</pubDate></item>
    <item><title>가정통신문 제2025-87호 급식 안내</title><link>https://school.example/sys/bbs/board.php?bo_table=letters&amp;wr_id=87</link><pubDate>Mon, 03 Nov 2025 01:00:00 +0000</pubDate></item>
  </channel></rss>`;
  const mock = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/sys/bbs/board.php' && u.searchParams.get('bo_table') === 'notice') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(listHtml); }
    if (u.pathname === '/sys/bbs/rss.php' && u.searchParams.get('bo_table') === 'letters') { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(rss); }
    res.writeHead(404); res.end('not found');
  });
  await new Promise((r) => mock.listen(0, r));
  const m = `http://localhost:${mock.address().port}`;
  try {
    const u = client(), adm = client();
    await u('POST', '/api/enter', { code: '2468' });
    await adm('POST', '/api/admin/login', { password: 'teacher!' });
    assert.equal((await u('POST', '/api/admin/news/sources', { sources: [] })).status, 403);
    assert.equal((await adm('POST', '/api/admin/news/sources', { sources: [{ name: '공지', url: 'ftp://x' }] })).status, 400);
    await adm('POST', '/api/admin/news/sources', { sources: [
      { name: '공지사항', url: `${m}/sys/bbs/board.php?bo_table=notice` },
      { name: '가정통신문', url: `${m}/sys/bbs/board.php?bo_table=letters` },
      { name: '고장난곳', url: 'http://localhost:1/board.php?bo_table=x' },
    ] });
    const st = (await adm('POST', '/api/admin/news/refresh')).data.status;
    assert.equal(st['공지사항'].via, 'html');
    assert.equal(st['가정통신문'].via, 'rss');
    assert.equal(st['고장난곳'].ok, false);

    const notice = (await u('GET', '/api/news?source=' + encodeURIComponent('공지사항'))).data.items;
    assert.deepEqual(notice.map((x) => [x.title, x.date]), [
      ['2025학년도 겨울방학 방과후학교 안내', '2025-11-10'],
      ['2학년 선택과목 설명회 개최 안내', '2025-11-07'],
    ]);
    assert.equal(notice[0].url, `${m}/sys/bbs/board.php?bo_table=notice&wr_id=120`);
    const all = (await u('GET', '/api/news')).data;
    assert.deepEqual(all.sources, ['공지사항', '가정통신문', '고장난곳']);
    assert.equal(all.items[0].title, '가정통신문 제2025-88호 수학여행 동의서');
    assert.equal(all.items[0].date, '2025-11-12');

    // 다시 가져와도 중복 없음
    await adm('POST', '/api/admin/news/refresh');
    assert.equal((await u('GET', '/api/news')).data.items.length, 4);
  } finally { mock.close(); }
});

test('학사일정: 나이스 5건 제한 분할 조회 · 기간 묶기 · 직접 등록 · 캘린더 파일', async () => {
  const http = require('node:http');
  const rows = require('./neis-fixture.json'); // 동탄국제고 실제 나이스 학사일정(2026.10~2027.5)에서 추출
  let calls = 0;
  const mock = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url, 'http://x');
    const from = u.searchParams.get('AA_FROM_YMD'), to = u.searchParams.get('AA_TO_YMD');
    const all = rows.filter((r) => r.AA_YMD >= from && r.AA_YMD <= to).sort((a, b) => a.AA_YMD.localeCompare(b.AA_YMD));
    const size = u.searchParams.get('KEY') ? 1000 : 5; // 키 없으면 실제 나이스처럼 5건만
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (!all.length) return res.end(JSON.stringify({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } }));
    res.end(JSON.stringify({ SchoolSchedule: [{ head: [{ list_total_count: all.length }, { RESULT: { CODE: 'INFO-000', MESSAGE: '정상' } }] }, { row: all.slice(0, size) }] }));
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.NEIS_BASE = `http://localhost:${mock.address().port}`;
  try {
    const { fetchRows, groupRows, toIcs } = require('../calendar.js');
    const got = await fetchRows({ office: 'J10', school: '7530976', key: '', from: '20261001', to: '20270531' });
    assert.equal(got.length, rows.length, '키 없이도 전부 수집');
    const keyed = (calls = 0, await fetchRows({ office: 'J10', school: '7530976', key: 'K', from: '20261001', to: '20270531' }));
    assert.equal(keyed.length, rows.length);
    assert.equal(calls, 1, '키가 있으면 1회 조회');

    const ev = groupRows(rows);
    const winter = ev.find((e) => e.title === '동계방학' && !e.grades);
    assert.deepEqual([winter.start, winter.end, winter.holiday], ['2027-01-08', '2027-01-29', 1]);
    assert.equal(ev.find((e) => e.title === '동계방학' && e.grades).grades, '3');
    assert.ok(!ev.some((e) => e.title === '토요휴업일'));
    const ics = toIcs({ id: 1, start: '2027-01-08', end: '2027-01-29', title: '동계방학', grades: '', detail: '' }, '동탄국제고');
    assert.match(ics, /DTSTART;VALUE=DATE:20270108/);
    assert.match(ics, /DTEND;VALUE=DATE:20270130/);

    // API: 운영자 직접 등록 + 다가오는 일정 + ics 다운로드
    const u = client(), adm = client();
    await u('POST', '/api/enter', { code: '2468' });
    await adm('POST', '/api/admin/login', { password: 'teacher!' });
    assert.equal((await u('POST', '/api/admin/events', { start: '2099-01-01', title: 'x' })).status, 403);
    assert.equal((await adm('POST', '/api/admin/events', { start: '2099-01-05', end: '2099-01-01', title: '잘못된 기간' })).status, 400);
    const t = new Date(Date.now() + 9 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
    const { data: { id } } = await adm('POST', '/api/admin/events', { start: t, title: '2학기 기말고사', grades: '1,2' });
    const up = (await u('GET', '/api/events/upcoming')).data.events;
    assert.ok(up.some((e) => e.id === id && e.grades === '1,2' && e.source === 'manual'));
    const res = await fetch(`${base}/api/events/${id}/ics`, { headers: { Cookie: '' } });
    assert.equal(res.status, 401, '입장 전에는 받을 수 없음');
    assert.equal((await adm('DELETE', `/api/admin/events/${id}`)).status, 200);
  } finally { mock.close(); delete process.env.NEIS_BASE; }
});
