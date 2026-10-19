// Used by the local installer to reload an already-installed unpacked copy.
// This page never reads credentials or webpage contents.
const expectedVersion = '3.0.0';
const currentVersion = chrome.runtime.getManifest().version;
if (currentVersion !== expectedVersion) {
  document.getElementById('status').textContent = '正在重新載入新版雙語伴讀…';
  chrome.runtime.reload();
} else {
  document.getElementById('status').textContent = `雙語伴讀 ${currentVersion} 已更新，可關閉這頁。`;
}
