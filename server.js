// 학부모 익명 소통 게시판 서버
// 외부 패키지 없이 Node.js(22.13+) 내장 기능만 사용합니다.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// 설정 (환경변수로 변경)
// ---------------------------------------------------------------------------
const CONFIG = {
  port: Number(process.env.PORT || 3000),
  schoolName: process.env.SCHOOL_NAME || '우리학교 학부모 소통방',
  accessCode: process.env.ACCESS_CODE || '1234', // 학부모 입장 코드 (가정통신문으로 안내)
  adminPassword: process.env.ADMIN_PASSWORD || 'admin1234', // 운영자(선생님) 비밀번호
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  reportHideThreshold: Number(process.env.REPORT_HIDE_THRESHOLD || 3),
  secureCookie: process.env.SECURE_COOKIE === '1',
  themeColor: /^#[0-9a-fA-F]{6}$/.test(process.env.THEME_COLOR || '') ? process.env.THEME_COLOR : '#2f6f4f', // 학교 상징색
  logo: process.env.SCHOOL_LOGO || '', // public 폴더 안 로고 파일 경로 (예: /logo.png)
};
if (!CONFIG.logo) {
  for (const f of ['logo.png', 'logo.svg', 'logo.jpg', 'logo.webp']) {
    if (fs.existsSync(path.join(__dirname, 'public', f))) { CONFIG.logo = '/' + f; break; }
  }
}

const CATEGORIES = {
  notice: '공지',
  free: '자유',
  question: '질문',
  suggestion: '건의',
  info: '정보공유',
};

fs.mkdirSync(CONFIG.dataDir, { recursive: true });

// 서명용 비밀키: 최초 실행 시 생성 후 보관
const secretPath = path.join(CONFIG.dataDir, 'secret.key');
if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const SECRET = process.env.SECRET || fs.readFileSync(secretPath, 'utf8').trim();

const hmac = (v) => crypto.createHmac('sha256', SECRET).update(String(v)).digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// ---------------------------------------------------------------------------
// 데이터베이스
// ---------------------------------------------------------------------------
const db = new DatabaseSync(process.env.DB_PATH || path.join(CONFIG.dataDir, 'board.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    nickname TEXT NOT NULL,
    author_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    reports INTEGER NOT NULL DEFAULT 0,
    comment_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    label TEXT NOT NULL,
    author_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    reports INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    voter_hash TEXT NOT NULL,
    PRIMARY KEY (post_id, voter_hash)
  );
  CREATE TABLE IF NOT EXISTS reports (
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    voter_hash TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (target_type, target_id, voter_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_posts_cat ON posts(category, created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
`);

// ---------------------------------------------------------------------------
// 콘텐츠 처리: 개인정보 자동 가림 + 비속어 필터
// ---------------------------------------------------------------------------
const BAD_WORDS = ['씨발', '시발', 'ㅅㅂ', '병신', 'ㅂㅅ', '개새끼', '좆', '지랄', '꺼져', '닥쳐', '미친놈', '미친년'];

function sanitizeText(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').trim();
  // 전화번호, 이메일, 주민번호 형태는 자동으로 가립니다 (익명성/개인정보 보호)
  t = t.replace(/\b\d{6}\s*-\s*[1-4]\d{6}\b/g, '[주민번호 가림]');
  t = t.replace(/(01[016789])[\s.-]?\d{3,4}[\s.-]?\d{4}/g, '[전화번호 가림]');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[이메일 가림]');
  for (const w of BAD_WORDS) t = t.split(w).join('*'.repeat(w.length));
  return t;
}

const ADJ = ['따뜻한', '부지런한', '다정한', '씩씩한', '차분한', '명랑한', '든든한', '포근한', '용감한', '상냥한', '슬기로운', '해맑은'];
const NOUN = ['해바라기', '민들레', '다람쥐', '고래', '참새', '코스모스', '토끼', '펭귄', '소나무', '은행나무', '수달', '부엉이'];
const EMOJI = { 해바라기: '🌻', 민들레: '🌼', 다람쥐: '🐿️', 고래: '🐋', 참새: '🐦', 코스모스: '🌸', 토끼: '🐰', 펭귄: '🐧', 소나무: '🌲', 은행나무: '🌳', 수달: '🦦', 부엉이: '🦉' };
const avatarOf = (nickname) => EMOJI[String(nickname).split(' ').pop()] || '🙂';
const randomNickname = () => `${ADJ[crypto.randomInt(ADJ.length)]} ${NOUN[crypto.randomInt(NOUN.length)]}`;

// ---------------------------------------------------------------------------
// 쿠키/세션 (가입 없음, 브라우저별 무작위 익명 ID)
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function signed(value) {
  return `${value}.${hmac(value).slice(0, 32)}`;
}
function unsign(raw) {
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const v = raw.slice(0, i);
  return safeEqual(raw.slice(i + 1), hmac(v).slice(0, 32)) ? v : null;
}

function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${CONFIG.secureCookie ? '; Secure' : ''}`;
}

function getSession(req) {
  const c = parseCookies(req);
  const clientId = unsign(c.sid);
  const admExp = unsign(c.adm);
  return {
    clientId,
    // 작성자 식별값은 서버 비밀키로 해시하여 저장 → DB가 유출돼도 브라우저와 연결 불가
    authorHash: clientId ? hmac('author:' + clientId) : null,
    admin: !!admExp && Number(admExp) > Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 남용 방지: 메모리 기반 속도 제한
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  buckets.set(key, arr);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.some((t) => now - t < 3600_000)) buckets.delete(k);
}, 600_000).unref();

// ---------------------------------------------------------------------------
// HTTP 유틸
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
};

function send(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extraHeaders });
  res.end(body);
}
const fail = (res, status, message) => send(res, status, { error: message });

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new Error('too_large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, '접근할 수 없습니다.');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// 응답 데이터 가공
// ---------------------------------------------------------------------------
function postView(p, s, { full = false } = {}) {
  const hiddenForUser = p.hidden && !s.admin;
  return {
    id: p.id,
    category: p.category,
    categoryName: CATEGORIES[p.category],
    title: hiddenForUser ? '신고 누적으로 숨겨진 글입니다' : p.title,
    body: full ? (hiddenForUser ? '운영자 검토 중인 글입니다.' : p.body) : undefined,
    preview: full || hiddenForUser ? undefined : p.body.slice(0, 80),
    nickname: p.is_admin ? '운영자' : p.nickname,
    avatar: p.is_admin ? '🏫' : avatarOf(p.nickname),
    isAdmin: !!p.is_admin,
    pinned: !!p.pinned,
    hidden: !!p.hidden,
    likes: p.likes,
    reports: s.admin ? p.reports : undefined,
    commentCount: p.comment_count,
    createdAt: p.created_at,
    mine: !!s.authorHash && p.author_hash === s.authorHash,
  };
}

function commentView(c, s) {
  const hiddenForUser = c.hidden && !s.admin;
  return {
    id: c.id,
    body: hiddenForUser ? '신고 누적으로 숨겨진 댓글입니다.' : c.body,
    label: c.is_admin ? '운영자' : c.label,
    isAdmin: !!c.is_admin,
    hidden: !!c.hidden,
    reports: s.admin ? c.reports : undefined,
    createdAt: c.created_at,
    mine: !!s.authorHash && c.author_hash === s.authorHash,
  };
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>\\d+)') + '$'), handler, opts });

route('GET', '/api/me', (req, res, s) => {
  send(res, 200, { entered: !!s.clientId, admin: s.admin, schoolName: CONFIG.schoolName, categories: CATEGORIES, themeColor: CONFIG.themeColor, logo: CONFIG.logo });
}, { public: true });

route('POST', '/api/enter', async (req, res, s, body, ip) => {
  if (!rateLimit('enter:' + ip, 10, 600_000)) return fail(res, 429, '잠시 후 다시 시도해주세요.');
  if (!safeEqual(String(body.code || '').trim(), CONFIG.accessCode)) return fail(res, 401, '입장 코드가 올바르지 않습니다.');
  const clientId = s.clientId || crypto.randomBytes(16).toString('hex');
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie('sid', signed(clientId), 60 * 60 * 24 * 365) });
}, { public: true });

route('POST', '/api/admin/login', (req, res, s, body, ip) => {
  if (!rateLimit('admin:' + ip, 5, 600_000)) return fail(res, 429, '잠시 후 다시 시도해주세요.');
  if (!safeEqual(String(body.password || ''), CONFIG.adminPassword)) return fail(res, 401, '비밀번호가 올바르지 않습니다.');
  const exp = Date.now() + 1000 * 60 * 60 * 12;
  const cookies = [cookie('adm', signed(String(exp)), 60 * 60 * 12)];
  if (!s.clientId) cookies.push(cookie('sid', signed(crypto.randomBytes(16).toString('hex')), 60 * 60 * 24 * 365));
  send(res, 200, { ok: true }, { 'Set-Cookie': cookies });
}, { public: true });

route('POST', '/api/admin/logout', (req, res) => {
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie('adm', '', 0) });
});

route('GET', '/api/posts', (req, res, s, body, ip, params, url) => {
  const category = url.searchParams.get('category');
  const q = (url.searchParams.get('q') || '').trim().slice(0, 50);
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const sort = url.searchParams.get('sort') === 'popular' ? 'popular' : 'latest';
  const pageSize = 20;
  const where = [];
  const args = [];
  if (category && CATEGORIES[category]) { where.push('category = ?'); args.push(category); }
  if (url.searchParams.get('mine') === '1') {
    where.push('(author_hash = ? OR id IN (SELECT post_id FROM comments WHERE author_hash = ?))');
    args.push(s.authorHash, s.authorHash);
  }
  if (q) { where.push('(title LIKE ? OR body LIKE ?) AND hidden = 0'); args.push(`%${q}%`, `%${q}%`); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const order = sort === 'popular' ? 'pinned DESC, likes DESC, comment_count DESC, id DESC' : 'pinned DESC, id DESC';
  const rows = db.prepare(`SELECT * FROM posts ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, pageSize + 1, (page - 1) * pageSize);
  send(res, 200, { posts: rows.slice(0, pageSize).map((p) => postView(p, s)), hasMore: rows.length > pageSize, page });
});

route('POST', '/api/posts', (req, res, s, body) => {
  if (!rateLimit('post:' + s.authorHash, 5, 600_000)) return fail(res, 429, '글은 10분에 5개까지 작성할 수 있습니다.');
  const category = String(body.category || '');
  if (!CATEGORIES[category]) return fail(res, 400, '말머리를 선택해주세요.');
  if (category === 'notice' && !s.admin) return fail(res, 403, '공지는 운영자만 작성할 수 있습니다.');
  const title = sanitizeText(body.title).slice(0, 100);
  const text = sanitizeText(body.body).slice(0, 5000);
  if (title.length < 2) return fail(res, 400, '제목을 2자 이상 입력해주세요.');
  if (text.length < 5) return fail(res, 400, '내용을 5자 이상 입력해주세요.');
  const asAdmin = s.admin && body.asAdmin !== false ? 1 : 0;
  const r = db.prepare('INSERT INTO posts (category, title, body, nickname, author_hash, is_admin, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(category, title, text, randomNickname(), s.authorHash, asAdmin, Date.now());
  send(res, 201, { id: Number(r.lastInsertRowid) });
});

function getPost(id) {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

route('GET', '/api/posts/:id', (req, res, s, body, ip, { id }) => {
  const p = getPost(id);
  if (!p) return fail(res, 404, '글을 찾을 수 없습니다.');
  const comments = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY id').all(id);
  const liked = !!db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND voter_hash = ?').get(id, s.authorHash);
  send(res, 200, { post: { ...postView(p, s, { full: true }), liked }, comments: comments.map((c) => commentView(c, s)) });
});

route('DELETE', '/api/posts/:id', (req, res, s, body, ip, { id }) => {
  const p = getPost(id);
  if (!p) return fail(res, 404, '글을 찾을 수 없습니다.');
  if (p.author_hash !== s.authorHash && !s.admin) return fail(res, 403, '본인 글만 삭제할 수 있습니다.');
  db.prepare('DELETE FROM reports WHERE target_type = ? AND target_id = ?').run('post', id);
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  send(res, 200, { ok: true });
});

route('POST', '/api/posts/:id/like', (req, res, s, body, ip, { id }) => {
  if (!getPost(id)) return fail(res, 404, '글을 찾을 수 없습니다.');
  const exists = db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND voter_hash = ?').get(id, s.authorHash);
  if (exists) db.prepare('DELETE FROM likes WHERE post_id = ? AND voter_hash = ?').run(id, s.authorHash);
  else db.prepare('INSERT INTO likes (post_id, voter_hash) VALUES (?, ?)').run(id, s.authorHash);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id);
  db.prepare('UPDATE posts SET likes = ? WHERE id = ?').run(n, id);
  send(res, 200, { liked: !exists, likes: n });
});

function report(res, s, type, id, reason) {
  const table = type === 'post' ? 'posts' : 'comments';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return fail(res, 404, '대상을 찾을 수 없습니다.');
  if (row.author_hash === s.authorHash) return fail(res, 400, '본인 글은 신고할 수 없습니다.');
  const r = db.prepare('INSERT OR IGNORE INTO reports (target_type, target_id, voter_hash, reason, created_at) VALUES (?,?,?,?,?)')
    .run(type, id, s.authorHash, String(reason || '').slice(0, 100), Date.now());
  if (!r.changes) return fail(res, 409, '이미 신고하셨습니다.');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ?').get(type, id);
  const hide = n >= CONFIG.reportHideThreshold && !row.is_admin ? 1 : row.hidden;
  db.prepare(`UPDATE ${table} SET reports = ?, hidden = ? WHERE id = ?`).run(n, hide, id);
  send(res, 200, { ok: true, hidden: !!hide });
}

route('POST', '/api/posts/:id/report', (req, res, s, body, ip, { id }) => report(res, s, 'post', id, body.reason));
route('POST', '/api/comments/:id/report', (req, res, s, body, ip, { id }) => report(res, s, 'comment', id, body.reason));

route('POST', '/api/posts/:id/comments', (req, res, s, body, ip, { id }) => {
  if (!rateLimit('comment:' + s.authorHash, 20, 600_000)) return fail(res, 429, '댓글은 10분에 20개까지 작성할 수 있습니다.');
  const p = getPost(id);
  if (!p) return fail(res, 404, '글을 찾을 수 없습니다.');
  const text = sanitizeText(body.body).slice(0, 1000);
  if (text.length < 1) return fail(res, 400, '댓글 내용을 입력해주세요.');
  const asAdmin = s.admin && body.asAdmin !== false ? 1 : 0;
  // 글 안에서만 일관된 익명 번호를 부여 (글쓴이 / 익명1 / 익명2 ...) → 다른 글과 연결 추적 불가
  let label;
  if (p.author_hash === s.authorHash) label = '글쓴이';
  else {
    const prev = db.prepare("SELECT label FROM comments WHERE post_id = ? AND author_hash = ? AND label != '글쓴이' LIMIT 1").get(id, s.authorHash);
    if (prev) label = prev.label;
    else {
      const { n } = db.prepare("SELECT COUNT(DISTINCT author_hash) AS n FROM comments WHERE post_id = ? AND author_hash != ?").get(id, p.author_hash);
      label = `익명${n + 1}`;
    }
  }
  db.prepare('INSERT INTO comments (post_id, body, label, author_hash, is_admin, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, text, label, s.authorHash, asAdmin, Date.now());
  db.prepare('UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?) WHERE id = ?').run(id, id);
  send(res, 201, { ok: true });
});

route('DELETE', '/api/comments/:id', (req, res, s, body, ip, { id }) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (!c) return fail(res, 404, '댓글을 찾을 수 없습니다.');
  if (c.author_hash !== s.authorHash && !s.admin) return fail(res, 403, '본인 댓글만 삭제할 수 있습니다.');
  db.prepare('DELETE FROM reports WHERE target_type = ? AND target_id = ?').run('comment', id);
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  db.prepare('UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?) WHERE id = ?').run(c.post_id, c.post_id);
  send(res, 200, { ok: true });
});

// --- 운영자 전용 ---
route('POST', '/api/admin/posts/:id/(?<action>pin|unpin|hide|unhide)', (req, res, s, body, ip, { id, action }) => {
  if (!getPost(id)) return fail(res, 404, '글을 찾을 수 없습니다.');
  const sql = { pin: 'pinned = 1', unpin: 'pinned = 0', hide: 'hidden = 1', unhide: 'hidden = 0, reports = 0' }[action];
  db.prepare(`UPDATE posts SET ${sql} WHERE id = ?`).run(id);
  if (action === 'unhide') db.prepare("DELETE FROM reports WHERE target_type = 'post' AND target_id = ?").run(id);
  send(res, 200, { ok: true });
}, { admin: true });

route('POST', '/api/admin/comments/:id/(?<action>hide|unhide)', (req, res, s, body, ip, { id, action }) => {
  const sql = action === 'hide' ? 'hidden = 1' : 'hidden = 0, reports = 0';
  db.prepare(`UPDATE comments SET ${sql} WHERE id = ?`).run(id);
  if (action === 'unhide') db.prepare("DELETE FROM reports WHERE target_type = 'comment' AND target_id = ?").run(id);
  send(res, 200, { ok: true });
}, { admin: true });

route('GET', '/api/admin/reports', (req, res, s) => {
  const posts = db.prepare('SELECT * FROM posts WHERE reports > 0 OR hidden = 1 ORDER BY reports DESC, id DESC LIMIT 100').all();
  const comments = db.prepare('SELECT * FROM comments WHERE reports > 0 OR hidden = 1 ORDER BY reports DESC, id DESC LIMIT 100').all();
  const reasons = db.prepare('SELECT target_type, target_id, reason FROM reports WHERE reason != \'\' ORDER BY created_at DESC LIMIT 500').all();
  const reasonMap = {};
  for (const r of reasons) (reasonMap[`${r.target_type}:${r.target_id}`] ||= []).push(r.reason);
  send(res, 200, {
    posts: posts.map((p) => ({ ...postView(p, s, { full: true }), reasons: reasonMap[`post:${p.id}`] || [] })),
    comments: comments.map((c) => ({ ...commentView(c, s), postId: c.post_id, reasons: reasonMap[`comment:${c.id}`] || [] })),
  });
}, { admin: true });

route('GET', '/api/admin/stats', (req, res) => {
  const since = Date.now() - 7 * 86400_000;
  const total = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  const week = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at > ?').get(since).n;
  const weekComments = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE created_at > ?').get(since).n;
  const byCategory = db.prepare('SELECT category, COUNT(*) AS n FROM posts WHERE created_at > ? GROUP BY category').all(since);
  const top = db.prepare('SELECT * FROM posts WHERE created_at > ? AND hidden = 0 ORDER BY likes DESC, comment_count DESC LIMIT 5').all(since);
  send(res, 200, {
    total, week, weekComments,
    byCategory: byCategory.map((r) => ({ name: CATEGORIES[r.category], n: r.n })),
    top: top.map((p) => ({ id: p.id, title: p.title, likes: p.likes, comments: p.comment_count, category: CATEGORIES[p.category] })),
  });
}, { admin: true });

// ---------------------------------------------------------------------------
// 서버
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  const ipKey = hmac('ip:' + ip).slice(0, 16); // IP는 저장하지 않고 속도 제한에만 해시로 사용

  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  // CSRF 방지: 변경 요청은 동일 출처에서만 허용
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return fail(res, 403, '허용되지 않은 요청입니다.');
  }

  const match = routes.map((r) => ({ r, m: r.method === req.method && url.pathname.match(r.re) })).find((x) => x.m);
  if (!match) return fail(res, 404, '없는 경로입니다.');

  const s = getSession(req);
  if (!match.r.opts.public && !s.clientId) return fail(res, 401, '입장 코드를 먼저 입력해주세요.');
  if (match.r.opts.admin && !s.admin) return fail(res, 403, '운영자만 사용할 수 있습니다.');

  try {
    const body = req.method === 'GET' ? {} : await readJson(req);
    const params = {};
    for (const [k, v] of Object.entries(match.m.groups || {})) params[k] = /^\d+$/.test(v) ? Number(v) : v;
    await match.r.handler(req, res, s, body, ipKey, params, url);
  } catch (e) {
    if (e.message === 'too_large') return fail(res, 413, '내용이 너무 깁니다.');
    if (e.message === 'bad_json') return fail(res, 400, '잘못된 요청입니다.');
    console.error(e);
    if (!res.headersSent) fail(res, 500, '서버 오류가 발생했습니다.');
  }
});

if (require.main === module) {
  server.listen(CONFIG.port, () => {
    console.log(`[${CONFIG.schoolName}] http://localhost:${CONFIG.port}`);
    if (!process.env.ACCESS_CODE || !process.env.ADMIN_PASSWORD) {
      console.warn('⚠ ACCESS_CODE / ADMIN_PASSWORD 환경변수를 꼭 설정하세요. (현재 기본값 사용 중)');
    }
  });
}

module.exports = { server, db, sanitizeText };
