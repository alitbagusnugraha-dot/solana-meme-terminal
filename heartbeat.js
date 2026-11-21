/*
 * Heartbeat worker — mengirim "tick" ke halaman setiap N milidetik.
 *
 * Browser memperlambat setInterval di tab yang tidak aktif (bisa sampai 1x per
 * menit di Chrome). Timer di dalam Web Worker tidak terkena pembatasan itu,
 * sehingga monitor harga & Auto TP/SL tetap berdetak tiap ±1 detik.
 */
let timer = null;

self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type === "start") {
    if (timer !== null) clearInterval(timer);
    const interval = typeof data.interval === "number" && data.interval >= 250 ? data.interval : 1000;
    timer = setInterval(() => {
      self.postMessage({ type: "tick", at: Date.now() });
    }, interval);
  } else if (data.type === "stop") {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
};
