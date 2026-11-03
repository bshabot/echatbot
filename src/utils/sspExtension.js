// Hand a list of style numbers to the "E. Chabot SSP Filler" Chrome extension.
// The extension's bridge script lives on this page; we talk to it with
// window.postMessage and wait for its acknowledgement.

export function sendBatchToSspExtension(styles, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const id = `b${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const done = (fn, v) => {
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      fn(v);
    };
    const onMsg = (e) => {
      if (e.source !== window || !e.data || e.data.type !== "ECHABOT_SSP_BATCH_ACK" || e.data.id !== id) return;
      if (e.data.ok) done(resolve, { count: e.data.count, ready: e.data.ready });
      else done(reject, new Error(e.data.error || "The extension couldn't load these styles"));
    };
    const timer = setTimeout(
      () => done(reject, new Error("The SSP extension didn't answer. Check it's installed and enabled in Chrome, reload this page, and try again.")),
      timeoutMs
    );
    window.addEventListener("message", onMsg);
    window.postMessage({ type: "ECHABOT_SSP_BATCH", id, styles }, window.location.origin);
  });
}
