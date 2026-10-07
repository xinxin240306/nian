const fs = require('fs');
const json = fs.readFileSync('d:/nian/stackchan/faces/NianGradient.json', 'utf8').trim();
const body =
  '#include "cat_face_json.h"\n\n' +
  'const char kCatFaceJson[] = R"json(\n' +
  json +
  '\n)json";\n';
const targets = [
  'd:/nian/stackchan/firmware-paramface/cat_face_json.cc',
  'D:/stackchan-mcp/firmware/main/boards/stackchan/paramface/cat_face_json.cc',
];
for (const t of targets) {
  fs.writeFileSync(t, body);
  console.log('wrote', t, body.length);
}
