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
