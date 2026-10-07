import * as api from './api.js';
import { exportAllArchivedMessages, restoreArchivedMessages } from './chat-thread-cache.js';
import { downloadTextFile } from './download-file.js';

function mergeMessages(serverMsgs, localMsgs) {
  const map = new Map();
  for (const m of serverMsgs || []) {
    const id = Number(m?.id);
    if (id > 0) map.set(id, m);
  }
  for (const m of localMsgs || []) {
    const id = Number(m?.id);
    if (id > 0 && !map.has(id)) map.set(id, m);
  }
  return [...map.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export async function buildClientBackup(types = ['all']) {
  const list = types?.length ? types : ['all'];
  const data = await api.exportData(list);
  const wantMessages = list.includes('all') || list.includes('messages');
  if (wantMessages) {
    const local = await exportAllArchivedMessages();
    if (local.length) {
      data.messages = mergeMessages(data.messages, local);
      data.phone_archive_merged = true;
      data.phone_archive_count = local.length;
    }
  }
  return data;
}

export async function downloadBackupFile(filename, data) {
  const r = await downloadTextFile(filename, JSON.stringify(data, null, 2), 'application/json');
  if (r.cancelled) return r;
  return { ok: r.ok !== false, via: r.via, cancelled: !!r.cancelled, messages: data.messages?.length || 0 };
}

export async function importBackupFile(data) {
  const result = await api.importData(data);
  if (Array.isArray(data?.messages) && data.messages.length) {
    await restoreArchivedMessages(data.messages);
  }
  return result;
}
