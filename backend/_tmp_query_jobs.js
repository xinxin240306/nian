const { initDB, getDB } = require('./db');

(async () => {
  await initDB();
  const db = getDB();
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  // use prepare API from wrapper
  const dbApi = require('./db');
  const rows = dbApi.prepare(`SELECT id, book_id, kind, status, error, created_at, updated_at FROM series_jobs ORDER BY id DESC LIMIT 20`).all();
  console.log('---jobs---');
  for (const r of rows) {
    console.log(JSON.stringify({
      id: r.id,
      book_id: r.book_id,
      kind: r.kind,
      status: r.status,
      error: String(r.error || '').slice(0, 350),
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }
  const books = dbApi.prepare(`
    SELECT id, title, mode, status, length_type, total_chapters, genres, era,
           length(book_outline) AS outline_len, updated_at
    FROM series_books ORDER BY id DESC LIMIT 12
  `).all();
  console.log('---books---');
  console.log(JSON.stringify(books, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
