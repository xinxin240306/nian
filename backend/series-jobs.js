/** 时空后台任务：大纲/写章等可离开页面继续跑 */
const db = require('./db');
const { push } = require('./push');
const seriesHelper = require('./series-helper');
const isekaiHelper = require('./isekai-helper');
const illusionHelper = require('./illusion-helper');

let _pumping = false;
const _queue = [];

function ensureJobsTable() {
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS series_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id INTEGER NOT NULL,
        chapter_no INTEGER DEFAULT 0,
        kind TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        payload TEXT DEFAULT '{}',
        error TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  } catch (_) { /* ignore */ }
}

function parsePayload(raw) {
  try {
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

function getJob(id) {
  ensureJobsTable();
  const row = db.prepare('SELECT * FROM series_jobs WHERE id=?').get(id);
  if (!row) return null;
  return { ...row, payload: parsePayload(row.payload) };
}

function listJobs(bookId) {
  ensureJobsTable();
  return db.prepare(
    `SELECT * FROM series_jobs WHERE book_id=? ORDER BY id DESC LIMIT 30`
  ).all(bookId).map((r) => ({ ...r, payload: parsePayload(r.payload) }));
}

/** 进程重启后：running 任务无人继续，章节会永久卡在 generating */
function recoverStaleJobs() {
  ensureJobsTable();
  try {
    const stale = db.prepare(
      `SELECT id, book_id, chapter_no, kind FROM series_jobs WHERE status='running'`
    ).all();
    for (const job of stale) {
      db.prepare(
        `UPDATE series_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`
      ).run('服务重启，任务中断，请重试', job.id);
      if (job.kind === 'chapter' || job.kind === 'director' || job.kind === 'isekai_start' || job.kind === 'illusion') {
        try {
          resetChapterAfterFailedJob(job);
        } catch (_) {}
      }
      if (job.kind === 'isekai_turn') {
        try {
          isekaiHelper.rollbackPlayTurnAi(
            job.book_id,
            job.chapter_no,
            job.payload?.turnIdBefore,
          );
        } catch (_) {}
      }
      if (job.kind === 'outline' || job.kind === 'isekai_outline') {
        try {
          db.prepare(
            `UPDATE series_books SET status='setup', updated_at=datetime('now') WHERE id=? AND status='outlining'`
          ).run(job.book_id);
        } catch (_) {}
      }
      if (job.kind === 'illusion') {
        try {
          db.prepare(
            `UPDATE series_books SET status='setup', updated_at=datetime('now') WHERE id=? AND status='writing'`
          ).run(job.book_id);
        } catch (_) {}
      }
    }
  } catch (_) {}
  // 章节 generating 但已无活跃任务：也解除卡住
  try {
    const stuck = db.prepare(`
      SELECT c.id FROM series_chapters c
      WHERE c.status='generating'
        AND NOT EXISTS (
          SELECT 1 FROM series_jobs j
          WHERE j.book_id=c.book_id AND j.chapter_no=c.chapter_no
            AND j.status IN ('queued','running')
            AND j.kind IN ('chapter','director','isekai_start','illusion')
        )
    `).all();
    for (const row of stuck) {
      db.prepare(
        `UPDATE series_chapters SET status='pending', updated_at=datetime('now') WHERE id=?`
      ).run(row.id);
    }
    db.prepare(`
      UPDATE series_books SET status='setup', updated_at=datetime('now')
      WHERE COALESCE(mode,'')='illusion' AND status='writing'
        AND NOT EXISTS (
          SELECT 1 FROM series_jobs j
          WHERE j.book_id=series_books.id AND j.status IN ('queued','running') AND j.kind='illusion'
        )
    `).run();
  } catch (_) {}
  // 穿越半成品 playing：只有 system briefing、没有正文 → 打回 pending
  try {
    const half = db.prepare(`
      SELECT c.id, c.book_id, c.chapter_no FROM series_chapters c
      WHERE c.status='playing'
        AND NOT EXISTS (
          SELECT 1 FROM series_turns t
          WHERE t.book_id=c.book_id AND t.chapter_no=c.chapter_no
            AND t.kind IN ('narration','char')
        )
        AND NOT EXISTS (
          SELECT 1 FROM series_jobs j
          WHERE j.book_id=c.book_id AND j.chapter_no=c.chapter_no
            AND j.status IN ('queued','running')
            AND j.kind='isekai_start'
        )
    `).all();
    for (const row of half) {
      try {
        db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=?').run(row.book_id, row.chapter_no);
      } catch (_) {}
      db.prepare(
        `UPDATE series_chapters SET status='pending', content='', quest_state='{}', updated_at=datetime('now') WHERE id=?`
      ).run(row.id);
    }
  } catch (_) {}
}

/** 任务失败后把章节从 generating/半成品 playing 收回可重试状态 */
function resetChapterAfterFailedJob(job) {
  const ch = seriesHelper.getChapter(job.book_id, job.chapter_no);
  if (!ch) return;
  if (job.kind === 'chapter' || job.kind === 'director') {
    if (ch.status === 'generating') {
      const back = job.kind === 'director' ? 'done' : 'pending';
      db.prepare(
        `UPDATE series_chapters SET status=?, updated_at=datetime('now') WHERE id=?`
      ).run(back === 'done' && ch.content ? 'done' : 'pending', ch.id);
    }
    return;
  }
  if (job.kind === 'isekai_start') {
    // generating 或只有 briefing 的 playing 都打回 pending
    const hasBody = db.prepare(
      `SELECT id FROM series_turns WHERE book_id=? AND chapter_no=? AND kind IN ('narration','char') LIMIT 1`
    ).get(job.book_id, job.chapter_no);
    if (ch.status === 'generating' || (ch.status === 'playing' && !hasBody)) {
      try {
        db.prepare('DELETE FROM series_turns WHERE book_id=? AND chapter_no=?').run(job.book_id, job.chapter_no);
      } catch (_) {}
      db.prepare(
        `UPDATE series_chapters SET status='pending', content='', quest_state='{}', updated_at=datetime('now') WHERE id=?`
      ).run(ch.id);
    }
  }
}

function enqueueJob(bookId, kind, { chapterNo = 0, payload = {} } = {}) {
  ensureJobsTable();
  // 入队前先检查时空 API，避免排队后才报错
  if (['outline', 'chapter', 'director', 'isekai_outline', 'isekai_begin', 'isekai_start', 'isekai_turn', 'illusion'].includes(kind)) {
    seriesHelper.requireSeriesApi();
  }
  const force = !!(payload && payload.force);
  // 同书同章同类未完成任务不重复入队
  const existing = db.prepare(`
    SELECT id, status FROM series_jobs
    WHERE book_id=? AND kind=? AND chapter_no=? AND status IN ('queued','running')
    LIMIT 1
  `).get(bookId, kind, chapterNo || 0);
  if (existing) {
    if (!force) return getJob(existing.id);
    // running 不可强杀（进程内仍在 await），避免双写互踩
    if (existing.status === 'running') {
      throw new Error('同类任务正在生成中，请稍后再试');
    }
    db.prepare(
      `UPDATE series_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`
    ).run('已被强制重试取代', existing.id);
  }

  if (kind === 'chapter' || kind === 'director' || kind === 'isekai_start' || kind === 'illusion') {
    const ch = seriesHelper.getChapter(bookId, chapterNo);
    if (ch) {
      if (kind === 'isekai_start' && ch.status === 'done') {
        throw new Error('本章已通关，不能重开。若要重玩请新建穿越本');
      }
      db.prepare(
        `UPDATE series_chapters SET status='generating', updated_at=datetime('now') WHERE id=?`
      ).run(ch.id);
    }
  }
  if (kind === 'illusion') {
    db.prepare(
      `UPDATE series_books SET status='writing', updated_at=datetime('now') WHERE id=?`
    ).run(bookId);
  }
  if (kind === 'outline' || kind === 'isekai_outline') {
    db.prepare(
      `UPDATE series_books SET status='outlining', updated_at=datetime('now') WHERE id=?`
    ).run(bookId);
  }

  const r = db.prepare(`
    INSERT INTO series_jobs (book_id, chapter_no, kind, status, payload)
    VALUES (?,?,?,?,?)
  `).run(bookId, chapterNo || 0, kind, 'queued', JSON.stringify(payload || {}));

  const job = getJob(r.lastInsertRowid);
  setImmediate(() => pumpJobs());
  return job;
}

async function runJob(job) {
  const payload = job.payload || {};
  switch (job.kind) {
    case 'outline':
      await seriesHelper.generateBookOutline(job.book_id);
      break;
    case 'chapter':
      await seriesHelper.generateChapter(job.book_id, job.chapter_no, {
        direction: payload.direction || '',
        force: !!payload.force,
      });
      break;
    case 'director':
      await seriesHelper.directorRewrite(job.book_id, job.chapter_no, payload.feedback || '');
      break;
    case 'isekai_outline':
      await isekaiHelper.generateScriptOutline(job.book_id);
      break;
    case 'isekai_begin':
      await isekaiHelper.beginTransmigrate(job.book_id, payload || {});
      break;
    case 'isekai_start':
      await isekaiHelper.startChapterPlay(job.book_id, job.chapter_no);
      break;
    case 'isekai_turn':
      await isekaiHelper.userPlayTurn(job.book_id, job.chapter_no, {
        continueAfterTurnId: payload.turnIdBefore,
      });
      break;
    case 'illusion':
      await illusionHelper.generateStory(job.book_id, { force: !!payload.force });
      break;
    default:
      throw new Error(`未知任务类型: ${job.kind}`);
  }
}

function kindLabel(kind) {
  return ({
    outline: '剧集大纲',
    chapter: '剧集章节',
    director: '导演重写',
    isekai_outline: '穿越大纲',
    isekai_begin: '开始穿越',
    isekai_start: '穿越开章',
    isekai_turn: '穿越续写',
    illusion: '幻象',
  })[kind] || '时空任务';
}

async function pumpJobs() {
  if (_pumping) return;
  _pumping = true;
  try {
    ensureJobsTable();
    for (;;) {
      const row = db.prepare(`
        SELECT * FROM series_jobs WHERE status='queued' ORDER BY id ASC LIMIT 1
      `).get();
      if (!row) break;
      db.prepare(
        `UPDATE series_jobs SET status='running', updated_at=datetime('now') WHERE id=?`
      ).run(row.id);
      const job = getJob(row.id);
      try {
        await runJob(job);
        db.prepare(
          `UPDATE series_jobs SET status='done', error='', updated_at=datetime('now') WHERE id=?`
        ).run(job.id);
        push('series_job', {
          jobId: job.id,
          bookId: job.book_id,
          chapterNo: job.chapter_no,
          kind: job.kind,
          status: 'done',
          message: `${kindLabel(job.kind)}已完成`,
        });
      } catch (e) {
        const msg = e.message || '生成失败';
        db.prepare(
          `UPDATE series_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`
        ).run(String(msg).slice(0, 500), job.id);
        // 章节失败回到 pending，避免卡在 generating / 半成品 playing
        if (job.kind === 'chapter' || job.kind === 'director' || job.kind === 'isekai_start' || job.kind === 'illusion') {
          try { resetChapterAfterFailedJob(job); } catch (_) {}
        }
        if (job.kind === 'illusion') {
          try {
            db.prepare(
              `UPDATE series_books SET status='setup', updated_at=datetime('now') WHERE id=? AND status='writing'`
            ).run(job.book_id);
          } catch (_) {}
        }
        if (job.kind === 'isekai_turn') {
          try {
            isekaiHelper.rollbackPlayTurnAi(
              job.book_id,
              job.chapter_no,
              job.payload?.turnIdBefore,
            );
          } catch (_) {}
        }
        if (job.kind === 'outline' || job.kind === 'isekai_outline') {
          try {
            db.prepare(
              `UPDATE series_books SET status='setup', updated_at=datetime('now') WHERE id=? AND status='outlining'`
            ).run(job.book_id);
          } catch (_) {}
        }
        push('series_job', {
          jobId: job.id,
          bookId: job.book_id,
          chapterNo: job.chapter_no,
          kind: job.kind,
          status: 'error',
          error: msg,
          message: `${kindLabel(job.kind)}失败：${msg}`,
        });
      }
    }
  } finally {
    _pumping = false;
    // 泵过程中又有新任务
    const more = db.prepare(
      `SELECT id FROM series_jobs WHERE status='queued' LIMIT 1`
    ).get();
    if (more) setImmediate(() => pumpJobs());
  }
}

ensureJobsTable();

module.exports = {
  enqueueJob,
  getJob,
  listJobs,
  pumpJobs,
  recoverStaleJobs,
  kindLabel,
};
