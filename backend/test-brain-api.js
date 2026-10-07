const http = require('http');

function apiFetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.get('http://localhost:3000' + path, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(json).slice(0,200)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${data.slice(0,200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function test() {
  // 先拿角色列表
  const chars = await apiFetch('/api/characters');
  console.log('Characters:', JSON.stringify(chars).slice(0, 300));
  if (!chars.length) { console.log('No chars'); return; }
  
  const charId = chars[0].id;
  console.log('\nTesting /api/brain/' + charId + '/experiences ...');
  try {
    const data = await apiFetch('/api/brain/' + charId + '/experiences');
    console.log('OK! items:', data.items?.length, 'edges:', data.edges?.length);
    console.log('trunk:', JSON.stringify(data.trunk).slice(0, 200));
  } catch (e) {
    console.error('FAILED:', e.message);
  }
}

test().catch(console.error);
