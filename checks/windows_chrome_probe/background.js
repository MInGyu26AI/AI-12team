// Test only (checks/check_windows_chrome.py): one request to the SyncUp native host as the real extension sends it
// (extension/lib/collector-rpc.ts), then the answer or the error to the test's report server.
// config.js, which the test writes next to this file, sets self.PROBE_REPORT_URL.
importScripts('config.js');

async function probe() {
  let report;
  try {
    const answer = await chrome.runtime.sendNativeMessage('com.syncup.collector', { version: 1, method: 'status', params: {} });
    report = { answer };
  } catch (error) {
    report = { error: String(error && error.message || error) };
  }
  await fetch(self.PROBE_REPORT_URL, { method: 'POST', body: JSON.stringify(report) });
}

probe();
