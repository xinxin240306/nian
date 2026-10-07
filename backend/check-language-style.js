const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(__dirname, 'nian.db');

async function checkLanguageStyle() {
  const SQL = await initSqlJs();
  const dbFile = fs.readFileSync(dbPath);
  const db = new SQL.Database(dbFile);
  
  // 搜索所有可能包含"本少爷"的字段
  const result = db.exec('SELECT id, name, personality, emotion_style, behavior, language_style FROM characters');
  
  if (result.length === 0) {
    console.log('未找到角色数据');
    return;
  }
  
  const columns = result[0].columns;
  const rows = result[0].values;
  
  rows.forEach(row => {
    const id = row[0];
    const name = row[1];
    const personality = row[2] || '';
    const emotion_style = row[3] || '';
    const behavior = row[4] || '';
    const language_style = row[5] || '';
    
    const allText = personality + emotion_style + behavior + language_style;
    
    if (allText.includes('本少爷')) {
      console.log('=== 🎯 找到了！角色:', name, '(ID:', id, ') ===');
      console.log('\n【性格】:', personality.slice(0, 200));
      console.log('\n【情感风格】:', emotion_style.slice(0, 200));
      console.log('\n【行为模式】:', behavior.slice(0, 200));
      console.log('\n【语言风格】:', language_style.slice(0, 200));
      console.log('\n⚠️  包含"本少爷"自称\n');
    }
  });
  
  db.close();
}

checkLanguageStyle().catch(console.error);
