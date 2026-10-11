// Pages for the tab session checks. The image on /driver/slow arrives
// SLOW_IMAGE_MS after it is requested, so network idle has a request to wait
// for, and /driver/worker starts a dedicated worker from a blob URL.
export const SLOW_IMAGE_MS = 800;

export const driverPages = {
  "/driver/slow": `<!doctype html><meta charset="utf-8"><title>Slow image page</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Slow image page</h1>
<img src="/driver/slow.png" alt="" width="1" height="1">`,
  "/driver/worker": `<!doctype html><meta charset="utf-8"><title>Worker page</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Worker page</h1>
<p id="worker-result" role="status">Worker starting</p>
<script>
const source = new Blob(['postMessage("worker-ready")'], { type: "text/javascript" });
const worker = new Worker(URL.createObjectURL(source));
worker.onmessage = (event) => { document.getElementById("worker-result").textContent = event.data; };
</script>`,
};
