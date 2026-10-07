const path = require('path');
const initSqlJs = require('sql.js');

(async () => {
  const _logs = [];
  const _orig = console.log;
  console.log = (...a) => { _logs.push(a.map(String).join(' ')); _orig(...a); };
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  const shim = {
    exec: (sql) => raw.run(sql),
    prepare: (sql) => ({
      get: (...args) => {
        const st = raw.prepare(sql); st.bind(args);
        const row = st.step() ? st.getAsObject() : undefined; st.free(); return row;
      },
      all: (...args) => {
        const st = raw.prepare(sql); st.bind(args);
        const rows = []; while (st.step()) rows.push(st.getAsObject()); st.free(); return rows;
      },
      run: (...args) => {
        raw.run(sql, args);
        const id = raw.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
        return { lastInsertRowid: id, changes: raw.getRowsModified() };
      },
    }),
  };
  require.cache[path.join(__dirname, 'db.js')] = { id: 'db', filename: 'db', loaded: true, exports: shim };

  raw.run(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
  raw.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id INTEGER, role TEXT, content TEXT, timestamp TEXT DEFAULT (datetime('now')), type TEXT, is_dream INTEGER DEFAULT 0, recalled INTEGER DEFAULT 0)`);
  // 平时：一天前，话多、欢快
  const chatty = ['哈哈哈你今天干嘛啦～', '我跟你说！今天食堂居然有草莓蛋糕', '嘿嘿想你了', '啊啊啊导师终于放过我了！！', '你猜我刚才看到什么了哈哈'];
  for (let i = 0; i < 30; i++) {
    raw.run(`INSERT INTO messages (character_id, role, content, timestamp) VALUES (1, 'user', ?, datetime('now', '-1 day'))`, [chatty[i % chatty.length]]);
    raw.run(`INSERT INTO messages (character_id, role, content, timestamp) VALUES (1, 'assistant', '嗯嗯', datetime('now', '-1 day'))`);
  }
  raw.run(`INSERT INTO settings VALUES ('user_read_migrated_1','1')`);

  const h = require('./user-read-helper');
  h.ensureTable();
  const hair = h.insertRead(1, {
    category: '行为习惯', section: 'fact', judgment: '头发老是吹半干就睡', reason: '她说过好几次',
    triggers: ['洗澡', '洗头', '吹头发', '睡前'], marks: ['吹干', '半干'], bad_habit: true,
  });
  h.insertRead(1, {
    category: '情绪反应', section: 'fact',
    judgment: '她生气时要放软语气好好哄，绝不能顺着她让她一个人冷静',
    reason: '那天因为我和别人走太近惹她生气。她说随便你、让我别管她去冷静。我第一次真听她的话晾着她，她更生气了。以后切记不能在她生气时让她一个人冷静。',
    triggers: ['生气', '冷静'], marks: ['哄', '冷静'],
    upset_signs: ['随便你', '别管我', '晚安', '没事'],
  });
  h.insertRead(1, {
    category: '在忙', section: 'recent', judgment: '在赶毕业论文', reason: '她这周一直在说',
    triggers: ['论文', '导师'], marks: ['论文'],
  });

  const say = (role, content) => raw.run(`INSERT INTO messages (character_id, role, content) VALUES (1, ?, ?)`, [role, content]);
  const turn = (userText, reply) => {
    say('user', userText);
    const block = h.formatForPrompt(1, userText);
    if (reply) say('assistant', typeof reply === 'function' ? reply(block) : reply);
    return block;
  };
  const tag = (b) => (b.includes('【可以顺口提一句】') ? '带一句' : b.includes('【你知道的对方】') ? '只知道' : b ? '其他' : '无');

  console.log('--- 无关的话 ---');
  console.log(tag(turn('今天中午吃了面', '好吃吗')));

  console.log('--- 连着 12 次说洗澡，看提不提 ---');
  const hist = [];
  for (let i = 0; i < 12; i++) {
    const b = turn('我刚洗完澡', (blk) => (blk.includes('【可以顺口提一句】') ? '洗完了？头发给我吹干再睡。' : '洗完舒服吧'));
    hist.push(tag(b));
  }
  console.log(hist.join(' '));
  const row = h.listReads(1).find((r) => r.id === hair.id);
  console.log('提及次数', row.mention_count, '最近提及', row.last_mentioned, '上次说法', row.last_said);

  console.log('--- 嫌唠叨 ---');
  const row2 = h.listReads(1).find((r) => r.id === hair.id);
  console.log('之前 nag_until:', row2.nag_until || '(无)');
  console.log(turn('知道了知道了别念了', '好好好') || '（无）');
  console.log('之后 nag_until:', h.listReads(1).find((r) => r.id === hair.id).nag_until || '(无)');

  const moodOf = (b) => (b.match(/【对方的情绪】[^\n]*/) || ['（不带情绪）'])[0];
  const step = (userText, reply) => console.log(`${userText.padEnd(16)} → ${moodOf(turn(userText, reply))}`);

  console.log('--- 平常开心（不该带） ---');
  step('哈哈今天好充实！我去睡啦晚安～', '晚安');

  console.log('--- 吵起来 → 冷淡 → 缓和 → 好转 ---');
  step('你怎么这样', '我怎么了？');
  step('嗯', '你到底想说什么');
  step('晚安', '……好吧');
  step('其实也没什么', '那你刚才');
  step('嘿嘿好啦不生你气了～', '哼');
  step('明天吃火锅吗', '吃');

  console.log('--- 画像信号：随便你 / 你忙吧 ---');
  const portraitHit = turn('随便你', null);
  console.log(portraitHit);
  const busy = h._senseNegative(1, '你忙吧', 0, h.listReads(1));
  console.log('你忙吧', JSON.stringify(busy));

  console.log('--- 同一条消息重复构建提示词，状态不重复推进 ---');
  say('user', '好烦啊');
  console.log(moodOf(h.formatForPrompt(1, '好烦啊')));
  console.log(moodOf(h.formatForPrompt(1, '好烦啊')));
  require('fs').writeFileSync(require('path').join(__dirname, '_test_out.txt'), _logs.join('\n'), 'utf8');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
