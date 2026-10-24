import { createServer } from "node:http";

// Sign-in pages for the form script: the four form kinds, a username-first
// step and its password step, a sign-in form in a same-origin frame and one in
// an open shadow root without a form element, and a page whose fields refuse
// some fills. Forms submit back to the site, which answers as each test needs.
export const signInPages = {
  "/passwords/sign-in": `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<style>body{font:14px sans-serif;margin:16px}label{display:block;margin:0 0 8px}</style>
<h1>Sign in</h1>
<form id="sign-in" method="post" action="/passwords/sign-in">
<label>Username <input id="username" name="username" autocomplete="username"></label>
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button id="submit" type="submit">Sign in</button>
</form>`,
  "/passwords/signed-in": `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Signed in</h1>
<p>Welcome back.</p>
<label>Search <input id="search" type="search"></label>`,
  "/passwords/sign-up": `<!doctype html><meta charset="utf-8"><title>Create an account</title>
<style>body{font:14px sans-serif;margin:16px}label{display:block;margin:0 0 8px}</style>
<h1>Create an account</h1>
<form id="sign-up" method="post" action="/passwords/sign-up">
<label>Email <input id="email" name="email" type="email"></label>
<label>Password <input id="new-password" name="password" type="password" autocomplete="new-password"></label>
<label>Confirm password <input id="confirm-password" name="confirm" type="password" autocomplete="new-password"></label>
<button id="submit" type="submit">Create account</button>
</form>`,
  "/passwords/change": `<!doctype html><meta charset="utf-8"><title>Change password</title>
<style>body{font:14px sans-serif;margin:16px}label{display:block;margin:0 0 8px}</style>
<h1>Change password</h1>
<form id="change" method="post" action="/passwords/change">
<input id="username" name="username" autocomplete="username" value="ada" hidden>
<label>Current password <input id="current-password" name="current" type="password" autocomplete="current-password"></label>
<label>New password <input id="new-password" name="password" type="password" autocomplete="new-password"></label>
<label>Confirm new password <input id="confirm-password" name="confirm" type="password" autocomplete="new-password"></label>
<button id="submit" type="submit">Change password</button>
</form>`,
  "/passwords/username-first": `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<style>body{font:14px sans-serif;margin:16px}label{display:block;margin:0 0 8px}</style>
<h1>Sign in</h1>
<form id="username-step" method="get" action="/passwords/password-step">
<label>Email <input id="username" name="username" type="email" autocomplete="username"></label>
<button id="next" type="submit">Next</button>
</form>`,
  "/passwords/password-step": `<!doctype html><meta charset="utf-8"><title>Enter your password</title>
<style>body{font:14px sans-serif;margin:16px}label{display:block;margin:0 0 8px}</style>
<h1>Enter your password</h1>
<form id="password-step" method="post" action="/passwords/sign-in">
<label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
<button id="submit" type="submit">Sign in</button>
</form>`,
  "/passwords/shadow": `<!doctype html><meta charset="utf-8"><title>Sign in</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Sign in</h1>
<x-sign-in id="widget"></x-sign-in>
<p id="shadow-result" role="status">Not signed in</p>
<script>
class XSignIn extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = '<label>Username <input id="shadow-username"></label><label>Password <input id="shadow-password" type="password"></label><button type="button" id="shadow-submit">Sign in</button>';
    root.getElementById("shadow-submit").onclick = () => { document.getElementById("shadow-result").textContent = "Signed in as " + root.getElementById("shadow-username").value; };
  }
}
customElements.define("x-sign-in", XSignIn);
</script>`,
  "/passwords/frames": `<!doctype html><meta charset="utf-8"><title>Embedded sign-in</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;width:420px;height:260px;border:2px solid #666}</style>
<h1>Embedded sign-in</h1>
<iframe id="sign-in-frame" title="Sign in" src="/passwords/sign-in"></iframe>`,
  "/passwords/fill": `<!doctype html><meta charset="utf-8"><title>Fill</title>
<style>body{font:14px sans-serif;margin:16px}form{margin:0 0 12px}</style>
<form id="plain"><input id="plain-username" autocomplete="username"><input id="plain-password" type="password"></form>
<form id="hidden"><input id="hidden-username" autocomplete="username" style="display:none"><input id="hidden-password" type="password"></form>
<form id="disabled"><input id="disabled-username"><input id="disabled-password" type="password" disabled></form>
<form id="readonly"><input id="readonly-username" value="grace" readonly><input id="readonly-password" type="password"></form>
<script>
// Records values written through the page's own setter and the events a
// fill fires.
window.setterCalls = [];
window.fillEvents = [];
const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
for (const input of document.querySelectorAll("input"))
  Object.defineProperty(input, "value", {
    configurable: true,
    get() { return value.get.call(this); },
    set(next) { setterCalls.push(this.id); value.set.call(this, next); },
  });
for (const type of ["input", "change"])
  document.addEventListener(type, (event) => fillEvents.push(type + " " + event.target.id));
</script>`,
};

// The site the end-to-end suites sign in to: these pages, the post the
// sign-in form makes, and one page behind HTTP Basic auth. Nothing leaves
// this machine, and every submission is kept so a check can read it.
export const SIGN_IN_PASSWORD = "correct horse 1";
export const BASIC_AUTH = {
  realm: "Kamapathy test realm",
  username: "basic-user",
  password: "basic pass 1",
};

export async function startSignInSite() {
  const posts = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (body, status = 200, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      });
      response.end(body);
    };
    if (url.pathname === "/passwords/basic") {
      const header = request.headers.authorization ?? "";
      const [name, secret] = header.startsWith("Basic ")
        ? Buffer.from(header.slice(6), "base64").toString("utf8").split(":")
        : [];
      if (name !== BASIC_AUTH.username || secret !== BASIC_AUTH.password)
        return send(
          `<!doctype html><meta charset="utf-8"><title>Sign in needed</title><p>Sign in to read this page.</p>`,
          401,
          {
            "WWW-Authenticate": `Basic realm="${BASIC_AUTH.realm}", charset="UTF-8"`,
          },
        );
      return send(
        `<!doctype html><meta charset="utf-8"><title>Basic auth done</title><h1>Basic auth done</h1><p>You are signed in.</p>`,
      );
    }
    const page = signInPages[url.pathname];
    if (request.method === "POST") {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192)
          return send("<!doctype html><title>Too large</title>", 413);
        chunks.push(chunk);
      }
      const fields = new URLSearchParams(
        Buffer.concat(chunks).toString("utf8"),
      );
      posts.push({
        path: url.pathname,
        username: fields.get("username") ?? "",
        password: fields.get("password") ?? "",
      });
      // A sign-in that worked leads to a page with no password field; a
      // wrong password brings the same form back.
      if (
        url.pathname === "/passwords/sign-in" &&
        fields.get("password") === SIGN_IN_PASSWORD
      ) {
        response.writeHead(303, {
          Location: "/passwords/signed-in",
          "Cache-Control": "no-store",
        });
        return response.end();
      }
      return page
        ? send(page)
        : send("<!doctype html><title>Page not found</title>", 404);
    }
    if (page) return send(page);
    send(
      '<!doctype html><meta charset="utf-8"><title>Page not found</title><p>No such page.</p>',
      404,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    altOrigin: `http://localhost:${port}`,
    posts,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
