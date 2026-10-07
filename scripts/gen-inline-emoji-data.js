/** 从 manifest 生成 js/inline-emoji-data.js（内嵌，避免网页再 fetch） */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'assets/inline-emoji/out/manifest.json'), 'utf8')
);
const emojis = (manifest.emojis || []).map((e) => ({
  code: e.code,
  file: e.file,
  aliases: e.aliases || [],
}));

const dataJs = `/** 由 scripts/gen-inline-emoji-data.js 生成，勿手改 */
export const INLINE_EMOJI_BASE = '/assets/inline-emoji/out';
export const INLINE_EMOJI_PACK = ${JSON.stringify({ version: 1, name: '小黄豆', emojis }, null, 2)};
`;
fs.writeFileSync(path.join(root, 'js/inline-emoji-data.js'), dataJs, 'utf8');
console.log('wrote js/inline-emoji-data.js', emojis.length);
