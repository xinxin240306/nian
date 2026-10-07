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
  console.log('\n=== char #2 brain experiences ===');
  try {
    const data = await apiFetch('/api/brain/2/experiences');
    console.log('OK! items:', data.items?.length, 'edges:', data.edges?.length);
    if (data.trunk) console.log('trunk:', JSON.stringify(data.trunk).slice(0, 200));
    if (data.items?.length > 0) {
      console.log('First item:', JSON.stringify(data.items[0]).slice(0, 300));
    }
  } catch (e) {
    console.error('FAILED:', e.message);
  }
  
  console.log('\n=== char #2 brain now ===');
  try {
    const data = await apiFetch('/api/brain/2/now');
    console.log('OK!', JSON.stringify(data).slice(0, 300));
  } catch (e) {
    console.error('FAILED:', e.message);
  }
}

test().catch(console.error);
