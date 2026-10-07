const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(__dirname, 'nian.db');

async function checkFullStyle() {
  const SQL = await initSqlJs();
  const dbFile = fs.readFileSync(dbPath);
  const db = new SQL.Database(dbFile);
  
  // 获取所有角色的完整语言风格
  const result = db.exec('SELECT id, name, language_style FROM characters WHERE language_style IS NOT NULL AND language_style != ""');
  
  if (result.length === 0) {
    console.log('未找到配置了语言风格的角色');
    return;
  }
  
  const rows = result[0].values;
  
  rows.forEach(row => {
    const id = row[0];
    const name = row[1];
    const language_style = row[2];
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`角色: ${name} (ID: ${id})`);
    console.log('='.repeat(60));
    console.log(language_style);
    console.log('='.repeat(60));
  });
  
  db.close();
}

checkFullStyle().catch(console.error);
