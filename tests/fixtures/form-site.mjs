import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { edgeCases } from './edge-cases.mjs';
import { componentPages } from './component-pages.mjs';
import { actionPages } from './action-pages.mjs';
import { framePages } from './frame-pages.mjs';
import { driverPages, SLOW_IMAGE_MS } from './driver-pages.mjs';
import { popupPages } from './popup-pages.mjs';
import { textPdf } from './pdf/index.mjs';
import { selectorPages } from './selector-pages.mjs';
import { snapshotPages } from './snapshot-pages.mjs';
import { scriptPageHeaders, scriptPages, serveScriptEndpoint } from './script-pages.mjs';

const escape = (value = '') => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const styles = `body{font:16px system-ui;margin:0;background:#f3f6f1;color:#24372c}header,main,footer{max-width:820px;margin:auto;padding:24px}header{border-bottom:1px solid #cfdbce}nav{display:flex;gap:20px}a{color:#285f39}h1{font-size:32px}label,legend{display:block;font-weight:600;margin:18px 0 8px}input:not([type=checkbox]):not([type=radio]),select,textarea{display:block;box-sizing:border-box;width:100%;max-width:640px;padding:10px;border:1px solid #9bac9b;border-radius:6px;font:inherit}button{padding:11px 18px;border:1px solid #426346;border-radius:6px;background:#36593e;color:white;font:inherit;margin:16px 8px 0 0}fieldset{border:1px solid #cfdbce;border-radius:8px;margin:20px 0;padding:12px 20px}fieldset label{font-weight:400}small{color:#58705c}pre{white-space:pre-wrap}#error{color:#912d26}.row{display:flex;align-items:center;gap:9px}.row label{margin:12px 0}footer{font-size:12px;color:#58705c}`;
const document = (title, body, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${styles}</style></head><body><header><strong>Kamapathy form lab</strong><nav aria-label="Lab navigation"><a href="/">Overview</a><a href="/forms/new">Create a form</a><a href="/lab">Interaction lab</a><a href="/benchmark">Reference page</a></nav></header><main>${body}</main><footer>Local test fixture. Submissions remain on this machine and are discarded when the server closes.</footer>${script ? `<script>${script}</script>` : ''}</body></html>`;
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The report the PDF checks read back, page by page. Page 2 holds the one
// sentence they look for.
export const REPORT_PAGES = [['Quarterly report', 'Prepared for the end-to-end checks'], ['The second page records reference 48213.'], ['Closing notes', 'End of the report']];
const reportPdf = textPdf(REPORT_PAGES, { title: 'Quarterly report' });

export async function startFormSite() {
  const forms = new Map();
  const submissions = [];
  const events = [];
  const requests = [];
  const csrf = randomUUID();
  // The ports this fixture answers on, in the order it opened them. The same
  // pages are served on both, so a page can hold a frame of its own name on
  // the other port beside one from the other loopback name.
  const ports = [];
  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ at: Date.now(), method: request.method, path: url.pathname, port: request.socket.localPort });
    const send = (title, body, script = '', status = 200) => {
      response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(document(title, body, script));
    };
    const redirect = destination => { response.writeHead(303, { Location: destination, 'Cache-Control': 'no-store' }); response.end(); };
    const readForm = async () => {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('Form too large'); chunks.push(chunk); }
      return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    };
    try {
      if (request.method === 'GET' && url.pathname === '/edges') return send('Browser edge cases', edgeCases.body, edgeCases.script);
      if (request.method === 'GET' && url.pathname === '/driver/slow.png') {
        await new Promise(resolve => setTimeout(resolve, SLOW_IMAGE_MS));
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return response.end(pixel, () => events.push({ type: 'slow-image-served', at: Date.now() }));
      }
      if (request.method === 'GET' && url.pathname === '/pdf/report.pdf') {
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'max-age=60' });
        return response.end(reportPdf);
      }
      // The same report, but only in answer to the form post, so a second
      // request for it shows up in requests.
      if (url.pathname === '/pdf/posted.pdf') {
        if (request.method !== 'POST') return send('Report not available', '<h1 id="error">Post the form to read this report.</h1>', '', 405);
        for await (const chunk of request) void chunk;
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
        return response.end(reportPdf);
      }
      if (request.method === 'GET' && url.pathname === '/pdf/links') return send('Report links', '<h1>Reports</h1><p><a id="report-link" href="/pdf/report.pdf" target="_blank">Open the report</a></p>');
      if (request.method === 'GET' && url.pathname === '/pdf/form') return send('Request the report', '<h1>Request the report</h1><form action="/pdf/posted.pdf" method="post"><input type="hidden" name="quarter" value="Q3"><button id="post-report" type="submit">Post for the report</button></form>');
      if (request.method === 'GET' && url.pathname === '/pdf/blob') return send('Build the report', '<h1>Build the report</h1><button id="open-blob">Open the blob report</button><p id="blob-status" role="status"></p>', `document.querySelector('#open-blob').onclick=async()=>{const bytes=await (await fetch('/pdf/report.pdf')).arrayBuffer();const opened=window.open(URL.createObjectURL(new Blob([bytes],{type:'application/pdf'})));document.querySelector('#blob-status').textContent=opened?'Blob report opened':'Blob report refused';};`);
      // The page script endpoints: the cookie echo, the CORS pair, the
      // binary body, the bodies that never end and the service worker.
      if (serveScriptEndpoint(request, response, url, events)) return;
      const page = request.method === 'GET' && (componentPages[url.pathname] ?? actionPages[url.pathname] ?? framePages[url.pathname] ?? driverPages[url.pathname] ?? popupPages[url.pathname] ?? selectorPages[url.pathname] ?? snapshotPages[url.pathname] ?? scriptPages[url.pathname]);
      if (typeof page === 'string') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...scriptPageHeaders[url.pathname] });
        // A page asking for {{other}} gets this server through its other
        // loopback name, which makes a frame of it cross origin. {{otherPort}}
        // keeps the name and changes the port, which Chromium runs in this
        // page's own process.
        const here = request.socket.localPort;
        const name = request.headers.host?.split(':')[0] ?? '127.0.0.1';
        const other = `http://${name === 'localhost' ? '127.0.0.1' : 'localhost'}:${here}`;
        const otherPort = `http://${name}:${here === ports[0] ? ports[1] : ports[0]}`;
        return response.end(page.replaceAll('{{other}}', other).replaceAll('{{otherPort}}', otherPort));
      }
      if (request.method === 'GET' && url.pathname === '/uploads') return send('File upload lab', `<h1>Upload test files</h1><form action="/upload-receipt" method="post" enctype="multipart/form-data"><label for="bundle">App bundle</label><input id="bundle" type="file" name="bundle" accept=".aab" required><section><label for="artwork">Artwork files</label><input id="artwork" style="display:none" type="file" name="artwork" accept="image/png" multiple></section><section hidden><input type="file" id="closed-upload" aria-label="Closed upload"></section><label for="disabled-upload">Disabled upload</label><input type="file" id="disabled-upload" disabled><button type="button" id="replace-upload">Replace bundle input</button><button type="submit">Submit files</button><p id="selected-status" role="status"></p></form>`, `document.querySelector('#replace-upload').onclick=()=>{const input=document.querySelector('#bundle');input.replaceWith(input.cloneNode());};document.querySelector('form').addEventListener('change',()=>{document.querySelector('#selected-status').textContent='Selected '+Array.from(document.querySelectorAll('input[type=file]')).reduce((n,input)=>n+input.files.length,0)+' files';});`);
      if (request.method === 'POST' && url.pathname === '/upload-receipt') {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Upload too large'); chunks.push(chunk); }
        const data = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
        const files = [];
        for (const [field, file] of data) if (typeof file !== 'string') files.push({ field, name: file.name, type: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
        events.push({ type: 'files-submitted', files });
        return send('Files received', `<h1 id="upload-confirmation">Files received</h1><p>${files.length} files received exactly once.</p><ul>${files.map(file=>`<li>${escape(file.name)}: ${file.bytes.length} bytes</li>`).join('')}</ul>`);
      }
      // A page that never answers, for runs that must hit their deadline.
      if (request.method === 'GET' && url.pathname === '/hold') return;
      if (request.method === 'POST' && url.pathname === '/popups/echo') {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('Form too large'); chunks.push(chunk); }
        events.push({ type: 'popup-echo', contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8'), origin: request.headers.origin, referer: request.headers.referer });
        return send('Echo received', '<h1 id="echo">Echo received</h1>');
      }
      if (url.pathname === '/popup-receipt') {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 32768) throw new Error('Form too large'); chunks.push(chunk); }
        const raw = Buffer.concat(chunks);
        const fields = request.method === 'POST' ? Object.fromEntries(await new Request('http://localhost', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: raw }).formData()) : {};
        events.push({ type: 'popup-submitted', method: request.method, contentType: request.headers['content-type'], referer: request.headers.referer, fields });
        return send('Popup receipt', `<h1 id="popup-confirmation">Popup submission received</h1><p>${escape(fields.message)}</p>`);
      }
      if (request.method === 'GET' && url.pathname === '/') return send('Kamapathy form lab', '<h1>Test a complete form workflow</h1><p>Create a form, fill it out, and verify a server receipt. This local site records real POST requests.</p><a id="create-form" href="/forms/new">Create your first form</a>');
      if (request.method === 'GET' && url.pathname === '/forms/new') return send('Create a form', `<h1>Create a form</h1><form action="/forms" method="post" id="builder"><input type="hidden" name="csrf" value="${csrf}"><label for="form-title">Form title</label><input id="form-title" name="title" required maxlength="100"><label for="form-description">Description</label><textarea id="form-description" name="description" maxlength="500"></textarea><label for="form-template">Template</label><select id="form-template" name="template"><option value="feedback">Product feedback</option><option value="research">Research request</option></select><button id="create-submit" type="submit">Create form</button></form>`);
      if (request.method === 'POST' && url.pathname === '/forms') {
        const body = await readForm();
        if (body.get('csrf') !== csrf || !body.get('title')?.trim()) return send('Form creation failed', '<h1 id="error">A valid title and token are required.</h1>', '', 422);
        const form = { id: `form-${forms.size + 1}`, title: body.get('title'), description: body.get('description'), template: body.get('template') };
        forms.set(form.id, form); events.push({ type: 'form-created', id: form.id });
        return redirect(`/forms/${form.id}`);
      }
      const formMatch = url.pathname.match(/^\/forms\/(form-\d+)$/);
      if (request.method === 'GET' && formMatch && forms.has(formMatch[1])) {
        const form = forms.get(formMatch[1]);
        return send(form.title, `<h1>${escape(form.title)}</h1><p>${escape(form.description)}</p><p id="form-created" role="status">Form created. Ready for a response.</p><form id="response-form" method="post" action="/forms/${form.id}/submit"><input type="hidden" name="csrf" value="${csrf}"><label for="respondent">Your name</label><input id="respondent" name="name" required><label for="email">Email address</label><input id="email" name="email" type="email" required><label for="topic">Topic</label><select id="topic" name="topic" required><option value="">Choose a topic</option><option value="browsing">Browsing</option><option value="automation">Automation</option><option value="design">Design</option></select><fieldset><legend>Priority</legend><label><input id="priority-normal" type="radio" name="priority" value="normal" checked> Normal</label><label><input id="priority-high" type="radio" name="priority" value="high"> High</label></fieldset><label for="notes">Your feedback</label><textarea id="notes" name="notes" required></textarea><button id="add-context" type="button">Add project context</button><div id="context-container"></div><div class="row"><input id="consent" name="consent" type="checkbox" value="yes" required><label for="consent">I agree to submit this local test response</label></div><button id="response-submit" type="submit">Submit response</button></form>`, `document.querySelector('#add-context').onclick=()=>{setTimeout(()=>{document.querySelector('#context-container').innerHTML='<label for="context">Project context</label><input id="context" name="context">';},160)};`);
      }
      const submitMatch = url.pathname.match(/^\/forms\/(form-\d+)\/submit$/);
      if (request.method === 'POST' && submitMatch && forms.has(submitMatch[1])) {
        const body = await readForm();
        if (body.get('csrf') !== csrf || !body.get('name')?.trim() || !/^\S+@\S+\.\S+$/.test(body.get('email') || '') || !body.get('topic') || !body.get('notes')?.trim() || body.get('consent') !== 'yes') return send('Response rejected', '<h1 id="error">Complete every required field and consent checkbox.</h1>', '', 422);
        const receipt = { id: `receipt-${submissions.length + 1}`, formId: submitMatch[1], name: body.get('name'), email: body.get('email'), topic: body.get('topic'), notes: body.get('notes'), priority: body.get('priority'), context: body.get('context') };
        submissions.push(receipt); events.push({ type: 'response-submitted', id: receipt.id });
        return redirect(`/receipts/${receipt.id}`);
      }
      const receiptMatch = url.pathname.match(/^\/receipts\/(receipt-\d+)$/);
      if (request.method === 'GET' && receiptMatch) {
        const receipt = submissions.find(item => item.id === receiptMatch[1]);
        if (receipt) return send('Submission received', `<h1 id="confirmation">Submission received</h1><p role="status">Your local response was saved exactly once.</p><dl><dt>Receipt</dt><dd id="receipt-id">${receipt.id}</dd><dt>Name</dt><dd>${escape(receipt.name)}</dd><dt>Topic</dt><dd>${escape(receipt.topic)}</dd><dt>Priority</dt><dd>${escape(receipt.priority)}</dd><dt>Feedback</dt><dd>${escape(receipt.notes)}</dd><dt>Project context</dt><dd>${escape(receipt.context)}</dd></dl><a id="another-form" href="/forms/new">Create another form</a>`);
      }
      if (request.method === 'GET' && url.pathname === '/lab') return send('Interaction lab', `<h1>Interaction lab</h1><p>Controls for deterministic browser testing.</p><label for="secret">Private input</label><input type="password" id="secret" value="hidden-fixture-value"><label for="readonly">Read only input</label><input id="readonly" value="do not change" readonly><button id="disabled" disabled>Disabled action</button><button id="replace">Replace control</button><label for="replaceable">Replaceable field</label><input id="replaceable"><label for="editable">Editable note</label><div id="editable" contenteditable="true" role="textbox" aria-label="Editable note" style="padding:12px;border:1px solid #cfdbce">Initial note</div><p id="editable-result" role="status"></p><label for="keyboard">Keyboard test</label><input id="keyboard"><p id="key-result" role="status">No key pressed</p><button id="delayed">Show delayed result</button><p id="delayed-result" role="status"></p><form id="enter-form" action="/enter" method="get"><label for="enter-query">Search fixture</label><input id="enter-query" name="q"><button id="enter-submit">Search fixture</button></form><div style="height:1000px"></div><button id="bottom-button">Bottom action</button><p id="bottom-result"></p>`, `document.querySelector('#editable').oninput=()=>{document.querySelector('#editable-result').textContent=document.querySelector('#editable').textContent;};document.querySelector('#replace').onclick=()=>{document.querySelector('#replaceable').outerHTML='<input id="replaceable" aria-label="Replacement field">';};document.querySelector('#keyboard').onkeydown=event=>{document.querySelector('#key-result').textContent='Pressed '+event.key;};document.querySelector('#delayed').onclick=()=>setTimeout(()=>{document.querySelector('#delayed-result').textContent='Delayed content ready';},250);document.querySelector('#bottom-button').onclick=()=>{document.querySelector('#bottom-result').textContent='Bottom action completed';};`);
      if (request.method === 'GET' && url.pathname === '/enter') return send('Keyboard search result', `<h1 id="enter-result">Search received: ${escape(url.searchParams.get('q'))}</h1>`);
      if (request.method === 'GET' && url.pathname === '/benchmark') {
        const rows = Array.from({ length: 18 }, (_, index) => `<article><h2>Research note ${index + 1}</h2><p>Reliable browser automation observes the page, identifies the intended control, performs an authorized action, and checks the visible result. Separate sessions keep unrelated projects apart.</p><a id="note-${index + 1}" href="/lab#note-${index + 1}">Read note ${index + 1}</a></article>`).join('');
        return send('Browser research reference', `<h1>Browser research reference</h1><p>A shared document for comparing observation output. All research notes and links belong to this local fixture.</p><form><label for="research-search">Search research</label><input id="research-search" placeholder="Find a note"><button id="research-submit">Search</button></form>${rows}`);
      }
      return send('Page not found', '<h1>Page not found</h1>', '', 404);
    } catch { return send('Request failed', '<h1>Request failed</h1>', '', 400); }
  };
  const servers = [createServer(handle), createServer(handle)];
  for (const listener of servers) {
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    ports.push(listener.address().port);
  }
  return { origin: `http://127.0.0.1:${ports[0]}`, ports: [...ports], forms, submissions, events, requests, close: () => Promise.all(servers.map(listener => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }))) };
}
