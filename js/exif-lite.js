/**
 * 轻量读 JPEG EXIF：拍摄时间 + GPS（没有就返回空）
 */
function readU16(view, off, le) {
  return le ? view.getUint16(off, true) : view.getUint16(off, false);
}
function readU32(view, off, le) {
  return le ? view.getUint32(off, true) : view.getUint32(off, false);
}

function parseGpsCoord(values, ref) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const n = (v) => {
    if (typeof v === 'number') return v;
    if (Array.isArray(v) && v.length >= 2) return Number(v[0]) / Number(v[1] || 1);
    return Number(v);
  };
  const d = n(values[0]);
  const m = n(values[1]);
  const s = values[2] != null ? n(values[2]) : 0;
  if (![d, m, s].every(Number.isFinite)) return null;
  let dec = d + m / 60 + s / 3600;
  const r = String(ref || '').toUpperCase();
  if (r === 'S' || r === 'W') dec = -dec;
  return dec;
}

function parseExifDate(s) {
  const m = String(s || '').trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return '';
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function readExifFromView(view, start) {
  if (view.byteLength < start + 8) return null;
  const le = view.getUint16(start, false) === 0x4949;
  if (!le && view.getUint16(start, false) !== 0x4d4d) return null;
  if (readU16(view, start + 2, le) !== 0x002a) return null;
  const ifd0 = start + readU32(view, start + 4, le);
  const tags = readIfd(view, ifd0, start, le);
  const exifOff = tags[0x8769];
  const gpsOff = tags[0x8825];
  const exif = exifOff ? readIfd(view, start + exifOff, start, le) : {};
  const gps = gpsOff ? readIfd(view, start + gpsOff, start, le) : {};
  const takenAt = parseExifDate(exif[0x9003] || tags[0x0132] || '');
  const lat = parseGpsCoord(gps[0x0002], gps[0x0001]);
  const lng = parseGpsCoord(gps[0x0004], gps[0x0003]);
  return {
    takenAt,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function readIfd(view, offset, tiffStart, le) {
  const out = {};
  if (offset < 0 || offset + 2 > view.byteLength) return out;
  const count = readU16(view, offset, le);
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = readU16(view, entry, le);
    const type = readU16(view, entry + 2, le);
    const num = readU32(view, entry + 4, le);
    const valOff = entry + 8;
    out[tag] = readTagValue(view, type, num, valOff, tiffStart, le);
  }
  return out;
}

function readTagValue(view, type, num, valOff, tiffStart, le) {
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
  const bytes = typeSize * num;
  let dataOff = valOff;
  if (bytes > 4) dataOff = tiffStart + readU32(view, valOff, le);
  if (dataOff < 0 || dataOff + bytes > view.byteLength) return null;
  if (type === 2) {
    let s = '';
    for (let i = 0; i < num; i++) {
      const c = view.getUint8(dataOff + i);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  if (type === 3 && num === 1) return readU16(view, dataOff, le);
  if (type === 4 && num === 1) return readU32(view, dataOff, le);
  if (type === 5) {
    const vals = [];
    for (let i = 0; i < num; i++) {
      const a = readU32(view, dataOff + i * 8, le);
      const b = readU32(view, dataOff + i * 8 + 4, le);
      vals.push([a, b]);
    }
    return num === 1 ? vals[0] : vals;
  }
  if (type === 1 || type === 7) {
    if (num === 1) return view.getUint8(dataOff);
    const arr = [];
    for (let i = 0; i < Math.min(num, 32); i++) arr.push(view.getUint8(dataOff + i));
    return arr;
  }
  return null;
}

export async function readImageExif(file) {
  const empty = { takenAt: '', lat: null, lng: null };
  if (!file || !/^image\/jpe?g$/i.test(file.type || '') && !/\.jpe?g$/i.test(file.name || '')) {
    return empty;
  }
  try {
    const buf = await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer();
    const view = new DataView(buf);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return empty;
    let offset = 2;
    while (offset + 4 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      const size = view.getUint16(offset + 2, false);
      if (marker === 0xe1) {
        const start = offset + 4;
        if (start + 6 < view.byteLength) {
          const head = String.fromCharCode(
            view.getUint8(start), view.getUint8(start + 1), view.getUint8(start + 2),
            view.getUint8(start + 3), view.getUint8(start + 4),
          );
          if (head === 'Exif\u0000') {
            return readExifFromView(view, start + 6) || empty;
          }
        }
      }
      if (size < 2) break;
      offset += 2 + size;
    }
  } catch {}
  return empty;
}

export function formatTakenAtInput(isoOrLocal) {
  const s = String(isoOrLocal || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : '';
  }
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
