// 학교 홈페이지 공지사항 · 가정통신문 연동
// - 게시판 목록에서 "제목 · 날짜 · 원문 링크"만 가져옵니다 (본문·첨부파일은 복사하지 않음)
// - 그누보드 계열 게시판(board.php?bo_table=...&wr_id=...)은 RSS를 먼저 시도하고, 안 되면 목록 HTML을 읽습니다.
'use strict';

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_PER_SOURCE = 40;

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
const clean = (html) => decodeEntities(String(html).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function normDate(y, m, d) {
  let yy = Number(y);
  if (yy < 100) yy += 2000;
  if (yy < 2000 || yy > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function findDate(text) {
  const m = String(text).match(/(\d{4}|\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  return m ? normDate(m[1], Number(m[2]), Number(m[3])) : null;
}

async function fetchText(url, timeoutMs = 15000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ParentsBoard/1.0)', Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('응답이 너무 큽니다');
  // 인코딩 감지 (오래된 학교 홈페이지는 EUC-KR인 경우가 있음)
  const head = buf.subarray(0, 4096).toString('latin1');
  const cs = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1]
    || head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
    || head.match(/encoding=["']([\w-]+)/i)?.[1] || 'utf-8';
  const enc = /euc-?kr|ks_c_5601|cp949/i.test(cs) ? 'euc-kr' : 'utf-8';
  return { text: new TextDecoder(enc).decode(buf), url: res.url || url };
}

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = m[0];
    const title = clean(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = decodeEntities(clean(block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || ''));
    const pub = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || block.match(/<dc:date>([\s\S]*?)<\/dc:date>/i)?.[1] || '';
    let date = findDate(pub);
    if (!date && pub) {
      const t = new Date(pub);
      if (!isNaN(t)) date = new Date(t.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    }
    if (title && /^https?:/i.test(link)) items.push({ title, url: link, date });
  }
  return items;
}

// 게시판 목록 HTML에서 글 링크(wr_id 등)를 찾아 제목·날짜를 뽑습니다.
function parseBoardHtml(html, pageUrl) {
  const page = new URL(pageUrl);
  const boTable = page.searchParams.get('bo_table');
  const byKey = new Map();
  const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rawHref = decodeEntities(m[1]);
    if (/^(javascript:|#|mailto:)/i.test(rawHref)) continue;
    let abs;
    try { abs = new URL(rawHref, page); } catch { continue; }
    const id = abs.searchParams.get('wr_id') || abs.searchParams.get('nttId') || abs.searchParams.get('seq') || abs.searchParams.get('idx') || abs.searchParams.get('no');
    if (!id || !/^\d+$/.test(id)) continue;
    if (boTable && abs.searchParams.get('bo_table') && abs.searchParams.get('bo_table') !== boTable) continue;
    if (abs.hash && /^#c_/.test(abs.hash)) continue; // 댓글 링크
    const title = clean(m[2]).replace(/^(새글|공지|NEW|N)\s+/i, '').replace(/\s*(새글|NEW)$/i, '').replace(/\s*\[\d+\]$/, '');
    if (title.length < 2 || /^\d+$/.test(title)) continue;
    // 같은 줄(tr/li) 안에서 날짜 찾기
    const rest = html.slice(re.lastIndex, re.lastIndex + 1500);
    const rowEnd = rest.search(/<\/tr>|<\/li>/i);
    const date = findDate(rowEnd >= 0 ? rest.slice(0, rowEnd) : rest.slice(0, 400));
    abs.hash = '';
    for (const p of ['page', 'sca', 'sfl', 'stx', 'sst', 'sod', 'spt']) abs.searchParams.delete(p);
    const key = id;
    const prev = byKey.get(key);
    if (!prev || title.length > prev.title.length) byKey.set(key, { title: title.slice(0, 200), url: abs.toString(), date: date || prev?.date || null, seq: Number(id) });
  }
  return [...byKey.values()].sort((a, b) => b.seq - a.seq);
}

function rssUrlFor(url) {
  const u = new URL(url);
  if (!/board\.php$/.test(u.pathname) || !u.searchParams.get('bo_table')) return null;
  return `${u.origin}${u.pathname.replace(/board\.php$/, 'rss.php')}?bo_table=${encodeURIComponent(u.searchParams.get('bo_table'))}`;
}

async function fetchSource(url) {
  const rss = rssUrlFor(url);
  if (rss) {
    try {
      const { text } = await fetchText(rss);
      if (/<rss|<feed|<rdf/i.test(text)) {
        const items = parseRss(text);
        if (items.length) return { items, via: 'rss' };
      }
    } catch { /* RSS가 없으면 목록 HTML로 */ }
  }
  const { text, url: finalUrl } = await fetchText(url);
  const items = parseBoardHtml(text, finalUrl);
  if (!items.length) throw new Error('게시판에서 글 목록을 찾지 못했습니다 (주소 확인 필요)');
  return { items, via: 'html' };
}

function createNews({ db, getSetting, setSetting }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      posted_at TEXT,
      seq INTEGER,
      first_seen INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_source ON school_news(source, posted_at);
  `);

  const getSources = () => {
    try { return JSON.parse(getSetting('news_sources', '[]')); } catch { return []; }
  };
  const getStatus = () => {
    try { return JSON.parse(getSetting('news_status', '{}')); } catch { return {}; }
  };

  function setSources(list) {
    const out = [];
    for (const s of list || []) {
      const name = String(s.name || '').trim().slice(0, 20);
      const url = String(s.url || '').trim();
      if (!name && !url) continue;
      if (!name) throw new Error('게시판 이름을 입력해주세요.');
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error(`「${name}」 주소는 http(s)://로 시작해야 합니다.`);
      out.push({ name, url });
    }
    if (out.length > 6) throw new Error('게시판은 6개까지 연결할 수 있습니다.');
    setSetting('news_sources', JSON.stringify(out));
    // 목록에서 빠진 게시판의 글은 정리
    const names = out.map((s) => s.name);
    db.prepare(`DELETE FROM school_news WHERE source NOT IN (${names.map(() => '?').join(',') || "''"})`).run(...names);
    return out;
  }

  let running = null;
  async function refresh() {
    if (running) return running;
    running = (async () => {
      const status = getStatus();
      const result = {};
      for (const src of getSources()) {
        const st = status[src.name] || {};
        try {
          const { items, via } = await fetchSource(src.url);
          const ins = db.prepare('INSERT INTO school_news (source, title, url, posted_at, seq, first_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET title = excluded.title, posted_at = COALESCE(excluded.posted_at, school_news.posted_at), source = excluded.source');
          const before = db.prepare('SELECT COUNT(*) AS n FROM school_news WHERE source = ?').get(src.name).n;
          const now = Date.now();
          items.slice(0, KEEP_PER_SOURCE).forEach((it, i) => ins.run(src.name, it.title, it.url, it.date, it.seq ?? (KEEP_PER_SOURCE - i), now));
          // 오래된 글 정리
          db.prepare(`DELETE FROM school_news WHERE source = ? AND id NOT IN (SELECT id FROM school_news WHERE source = ? ORDER BY COALESCE(posted_at, '') DESC, seq DESC LIMIT ${KEEP_PER_SOURCE})`).run(src.name, src.name);
          const after = db.prepare('SELECT COUNT(*) AS n FROM school_news WHERE source = ?').get(src.name).n;
          status[src.name] = { ok: true, at: now, via, count: items.length, added: Math.max(0, after - before) };
        } catch (e) {
          status[src.name] = { ...st, ok: false, at: Date.now(), error: e.name === 'TimeoutError' ? '시간 초과 (학교 서버 응답 없음)' : String(e.cause?.code || e.message) };
        }
        result[src.name] = status[src.name];
      }
      setSetting('news_status', JSON.stringify(status));
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  function list({ source, limit = 30 } = {}) {
    const args = [];
    let where = '';
    if (source) { where = 'WHERE source = ?'; args.push(source); }
    return db.prepare(`SELECT id, source, title, url, posted_at AS date, first_seen AS firstSeen FROM school_news ${where}
      ORDER BY COALESCE(posted_at, '') DESC, seq DESC, id DESC LIMIT ?`).all(...args, Math.min(100, limit));
  }

  function start(intervalMin = 30) {
    setTimeout(() => refresh().catch(() => {}), 5000).unref();
    setInterval(() => refresh().catch(() => {}), intervalMin * 60_000).unref();
  }

  return { getSources, setSources, getStatus, refresh, list, start };
}

module.exports = { createNews, parseBoardHtml, parseRss, findDate };
