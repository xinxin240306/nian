/* ===== 印象页 → 大脑「画像」分区 ===== */
window.initImpressionPage = async function() {
  window._memoryMode = 'brain';
  window._memoryInitTab = 'portrait';
  window.navigateTo?.('memory');
};
