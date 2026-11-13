// 학사일정: 나이스(NEIS) 교육정보 개방 포털 학사일정 API 연동 + 운영자 직접 등록 일정
// - API 키가 있으면 한 번에 조회, 없으면(체험 모드: 요청당 5건 제한) 기간을 나눠 빠짐없이 조회합니다.
// - 같은 행사가 여러 날 이어지면(예: 기말고사) 하나의 기간 일정으로 묶습니다.
'use strict';

const neisBase = () => process.env.NEIS_BASE || 'https://open.neis.go.kr/hub'; // 테스트 시 모의 서버로 변경
const SKIP_EVENTS = /^(토요휴업일|일요일|공휴일)$/; // 매주 반복되는 의미 없는 항목

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const iso = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (isoDate, n) => new Date(new Date(isoDate + 'T00:00:00Z').getTime() + n * 86400_000).toISOString().slice(0, 10);

async function neisGet(service, params, key) {
  const u = new URL(`${neisBase()}/${service}`);
  u.search = new URLSearchParams({ Type: 'json', pIndex: '1', pSize: key ? '1000' : '5', ...(key ? { KEY: key } : {}), ...params });
  const res = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'ParentsBoard/1.0' } });
  if (!res.ok) throw new Error(`나이스 응답 오류 HTTP ${res.status}`);
  const data = await res.json();
  if (data.RESULT) { // 데이터 없음 또는 오류
    if (data.RESULT.CODE === 'INFO-200') return { rows: [], total: 0 };
    throw new Error(`나이스: ${data.RESULT.MESSAGE} (${data.RESULT.CODE})`);
  }
  const block = data[service];
  const head = block?.[0]?.head || [];
  const result = head[1]?.RESULT;
  if (result && result.CODE !== 'INFO-000') throw new Error(`나이스: ${result.MESSAGE} (${result.CODE})`);
  return { rows: block?.[1]?.row || [], total: head[0]?.list_total_count || 0 };
}

// 학교 검색 (운영자 화면에서 학교 선택용)
async function searchSchools(name, key) {
  const { rows } = await neisGet('schoolInfo', { SCHUL_NM: name }, key);
  return rows.map((r) => ({ office: r.ATPT_OFCDC_SC_CODE, officeName: r.ATPT_OFCDC_SC_NM, code: r.SD_SCHUL_CODE, name: r.SCHUL_NM, address: r.ORG_RDNMA, homepage: r.HMPG_ADRES }));
}

// 기간 학사일정 원본 행 가져오기. 키가 없으면 5건 제한을 피하려고 기간을 반씩 나눠 재귀 조회.
async function fetchRows({ office, school, key, from, to }, depth = 0) {
  const { rows, total } = await neisGet('SchoolSchedule', { ATPT_OFCDC_SC_CODE: office, SD_SCHUL_CODE: school, AA_FROM_YMD: from, AA_TO_YMD: to }, key);
  if (key || total <= rows.length || from === to || depth > 12) return rows;
  const a = new Date(iso(from) + 'T00:00:00Z').getTime();
  const b = new Date(iso(to) + 'T00:00:00Z').getTime();
  const mid = new Date(a + Math.floor((b - a) / 86400_000 / 2) * 86400_000);
  const left = await fetchRows({ office, school, key, from, to: ymd(mid) }, depth + 1);
  const right = await fetchRows({ office, school, key, from: ymd(new Date(mid.getTime() + 86400_000)), to }, depth + 1);
  return [...left, ...right];
}

// 원본 행 → 화면용 일정 (연속된 같은 행사는 기간으로 묶음)
function groupRows(rows) {
  const items = rows
    .filter((r) => r.EVENT_NM && !SKIP_EVENTS.test(r.EVENT_NM.trim()))
    .map((r) => {
      const grades = [['1', r.ONE_GRADE_EVENT_YN], ['2', r.TW_GRADE_EVENT_YN], ['3', r.THREE_GRADE_EVENT_YN]].filter(([, y]) => y === 'Y').map(([g]) => g);
      return {
        date: iso(r.AA_YMD),
        title: r.EVENT_NM.trim(),
        detail: (r.EVENT_CNTNT || '').trim(),
        grades: grades.length === 3 || grades.length === 0 ? '' : grades.join(','),
        holiday: r.SBTR_DD_SC_NM === '휴업일' ? 1 : 0,
      };
    })
    .sort((x, y) => (x.title + x.grades).localeCompare(y.title + y.grades) || x.date.localeCompare(y.date));

  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    // 같은 행사·같은 학년이고, 끝난 날로부터 3일 이내(주말 사이)로 이어지면 하나로
    if (last && last.title === it.title && last.grades === it.grades && last.detail === it.detail
        && it.date > last.end && it.date <= addDays(last.end, 3) && workdaysBetween(last.end, it.date) === 0) {
      last.end = it.date;
    } else {
      out.push({ start: it.date, end: it.date, title: it.title, detail: it.detail, grades: it.grades, holiday: it.holiday });
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}
// 두 날짜 사이(양 끝 제외)의 평일 수
function workdaysBetween(a, b) {
  let n = 0;
  for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function createCalendar({ db, getSetting, setSetting }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,          -- neis(나이스 자동) | manual(운영자 등록)
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      grades TEXT NOT NULL DEFAULT '',  -- '' = 전체, '1' / '1,2' 등
      holiday INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(start_date, end_date);
  `);

  const getConfig = () => {
    try { return JSON.parse(getSetting('neis', '{}')); } catch { return {}; }
  };
  const getStatus = () => {
    try { return JSON.parse(getSetting('neis_status', '{}')); } catch { return {}; }
  };
  function setConfig({ office, school, schoolName, key }) {
    const cur = getConfig();
    const next = {
      office: String(office ?? cur.office ?? '').trim().slice(0, 10),
      school: String(school ?? cur.school ?? '').trim().slice(0, 20),
      schoolName: String(schoolName ?? cur.schoolName ?? '').trim().slice(0, 40),
      key: key === undefined ? cur.key || '' : String(key).trim().slice(0, 64),
    };
    if (next.school && !/^[A-Z]\d{2}$/.test(next.office)) throw new Error('교육청 코드 형식이 올바르지 않습니다 (예: J10).');
    if (next.school && !/^\d{5,10}$/.test(next.school)) throw new Error('학교 코드 형식이 올바르지 않습니다 (예: 7530976).');
    setSetting('neis', JSON.stringify(next));
    return next;
  }

  let running = null;
  async function sync() {
    if (running) return running;
    running = (async () => {
      const cfg = getConfig();
      if (!cfg.office || !cfg.school) return null;
      const from = addDays(kstToday(), -31);
      const to = addDays(kstToday(), 200);
      try {
        const rows = await fetchRows({ office: cfg.office, school: cfg.school, key: cfg.key, from: from.replace(/-/g, ''), to: to.replace(/-/g, '') });
        const events = groupRows(rows);
        db.exec('BEGIN');
        try {
          db.prepare("DELETE FROM events WHERE source = 'neis' AND end_date >= ? AND start_date <= ?").run(from, to);
          const ins = db.prepare("INSERT INTO events (source, start_date, end_date, title, detail, grades, holiday, created_at) VALUES ('neis',?,?,?,?,?,?,?)");
          const now = Date.now();
          for (const e of events) ins.run(e.start, e.end, e.title.slice(0, 60), e.detail.slice(0, 200), e.grades, e.holiday, now);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        const st = { ok: true, at: Date.now(), count: events.length, rows: rows.length, mode: cfg.key ? '인증키' : '체험(키 없음)' };
        setSetting('neis_status', JSON.stringify(st));
        return st;
      } catch (e) {
        const st = { ...getStatus(), ok: false, at: Date.now(), error: e.name === 'TimeoutError' ? '시간 초과 (나이스 응답 없음)' : String(e.cause?.code || e.message) };
        setSetting('neis_status', JSON.stringify(st));
        return st;
      }
    })().finally(() => { running = null; });
    return running;
  }

  const view = (r) => ({ id: r.id, source: r.source, start: r.start_date, end: r.end_date, title: r.title, detail: r.detail, grades: r.grades, holiday: !!r.holiday });

  function list({ from, to, limit = 300 } = {}) {
    from = from || addDays(kstToday(), -31);
    to = to || addDays(kstToday(), 200);
    return db.prepare('SELECT * FROM events WHERE end_date >= ? AND start_date <= ? ORDER BY start_date, holiday DESC, id LIMIT ?').all(from, to, Math.min(1000, limit)).map(view);
  }
  function upcoming(limit = 5) {
    return db.prepare('SELECT * FROM events WHERE end_date >= ? ORDER BY start_date, holiday DESC, id LIMIT ?').all(kstToday(), limit).map(view);
  }
  const get = (id) => { const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id); return r && view(r); };

  function addManual(body) {
    const start = String(body.start || '');
    const end = String(body.end || body.start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) throw new Error('날짜를 올바르게 입력해주세요.');
    const title = String(body.title || '').trim().slice(0, 60);
    if (title.length < 2) throw new Error('일정 이름을 2자 이상 입력해주세요.');
    const grades = String(body.grades || '').split(',').filter((g) => /^[123]$/.test(g)).sort().join(',');
    const r = db.prepare("INSERT INTO events (source, start_date, end_date, title, detail, grades, holiday, created_at) VALUES ('manual',?,?,?,?,?,0,?)")
      .run(start, end, title, String(body.detail || '').trim().slice(0, 200), grades === '1,2,3' ? '' : grades, Date.now());
    return Number(r.lastInsertRowid);
  }
  const removeManual = (id) => db.prepare("DELETE FROM events WHERE id = ? AND source = 'manual'").run(id).changes;

  function start(intervalHours = 6) {
    setTimeout(() => sync().catch(() => {}), 8000).unref();
    setInterval(() => sync().catch(() => {}), intervalHours * 3600_000).unref();
  }

  return { getConfig, setConfig, getStatus, sync, list, upcoming, get, addManual, removeManual, start, searchSchools: (name) => searchSchools(name, getConfig().key) };
}

// 일정 하나를 휴대폰 캘린더에 추가할 수 있는 .ics 파일로
function toIcs(ev, schoolName) {
  const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const d = (s) => s.replace(/-/g, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ParentsBoard//KO', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:event-${ev.id}@parents-board`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;VALUE=DATE:${d(ev.start)}`,
    `DTEND;VALUE=DATE:${d(addDays(ev.end, 1))}`,
    `SUMMARY:${esc(`[${schoolName}] ${ev.title}${ev.grades ? ` (${ev.grades.replace(/,/g, '·')}학년)` : ''}`)}`,
    ev.detail ? `DESCRIPTION:${esc(ev.detail)}` : null,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].filter((x) => x !== null).join('\r\n');
}

module.exports = { createCalendar, groupRows, fetchRows, searchSchools, toIcs };
