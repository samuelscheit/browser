import type { Server } from "bun";

/** Test site for the task agent. Pages record what happened in a `#log` element. */

const page = (title: string, body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const LOG_SCRIPT = `<pre id="log"></pre><script>function log(line) { document.getElementById('log').textContent += line + '\\n'; }</script>`;

export const PASSWORD = "correct horse battery staple";

const ITEMS = [
  { id: "1", name: "Blue Widget", price: "$12.00", sku: "BW-001" },
  { id: "2", name: "Red Widget", price: "$42.50", sku: "RW-042" },
  { id: "3", name: "Green Gadget", price: "$7.25", sku: "GG-007" },
];

function routes(otherOrigin: string): Record<string, (request: Request, url: URL) => Response | Promise<Response>> {
  const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...(init.headers ?? {}) } });
  return {
    "/form": () => html(page("Form", `
      <h1>Account form</h1>
      <form id="form" onsubmit="event.preventDefault(); log('submitted ' + new URLSearchParams(new FormData(this)))">
        <label for="email">Email address</label> <input id="email" name="email" type="email" required>
        <label>Password <input name="password" type="password"></label>
        <span id="country-label">Country</span>
        <select name="country" aria-labelledby="country-label"><option value="">Choose…</option><option value="de">Germany</option><option value="fr">France</option></select>
        <input name="nick" placeholder="Nickname">
        <textarea name="bio" aria-label="Biography">Hello</textarea>
        <input name="birthday" type="date" aria-label="Birthday">
        <label class="fancy"><input type="checkbox" name="terms" style="position:absolute;opacity:0;width:1px;height:1px"> Accept terms</label>
        <div contenteditable="true" aria-label="Notes" style="min-height:20px;border:1px solid"></div>
        <button type="button" disabled>Disabled action</button>
        <button id="save" type="submit">Save</button>
        <a href="/form#help">Help</a>
        <a href="/form#up"><span title="upvote" style="display:inline-block;width:10px;height:10px;background:gray"></span></a>
        <div onclick="log('div clicked')" style="cursor:pointer">Clickable div</div>
        <div style="cursor:pointer" onclick="log('wrapper')"><button type="button" onclick="log('inner button')">Wrapped button</button></div>
        <section style="display:contents"><button type="button" onclick="log('contents child')">Inside display contents</button></section>
      </form>
      <button style="display:none">Hidden display</button>
      <button style="visibility:hidden">Hidden visibility</button>
      <button hidden>Hidden attribute</button>
      <button style="width:0;height:0;padding:0;border:0;overflow:hidden">Zero size</button>
      <button style="opacity:0">Transparent</button>
      <div inert><button>Inert button</button></div>
      <button style="position:absolute;left:-5000px">Offscreen left</button>
      <div style="height:3000px"></div>
      <button onclick="log('far clicked')">Far below</button>
      ${LOG_SCRIPT}`)),

    "/shadow": () => html(page("Shadow", `
      <h1>Shadow DOM</h1>
      <x-card></x-card>
      ${LOG_SCRIPT}
      <script>
        customElements.define('x-card', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<input aria-label="Shadow input"><button>Shadow button</button><x-inner></x-inner>';
            root.querySelector('button').onclick = () => log('shadow clicked ' + root.querySelector('input').value);
          }
        });
        customElements.define('x-inner', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<button>Nested shadow button</button>';
            root.querySelector('button').onclick = () => log('nested shadow clicked');
          }
        });
      </script>`)),

    "/frames": () => html(page("Frames", `
      <h1>Frames</h1>
      <div style="height:200px"></div>
      <iframe id="same" src="/frame-inner?name=same" style="width:400px;height:150px;border:5px solid;padding:7px"></iframe>
      <iframe id="cross" src="${otherOrigin}/frame-inner?name=cross&nest=1" style="width:500px;height:320px;margin-left:30px;border:3px solid"></iframe>
      <div style="height:1500px"></div>
      <iframe id="below" src="${otherOrigin}/frame-inner?name=below" style="width:300px;height:150px"></iframe>`)),

    "/frame-inner": (_request, url) => {
      const name = url.searchParams.get("name") ?? "frame";
      const nested = url.searchParams.get("nest") ? `<iframe src="/frame-inner?name=${name}-nested" style="width:300px;height:120px;margin-top:10px"></iframe>` : "";
      return html(page(`Inner ${name}`, `<p>Frame ${name} text</p><input aria-label="${name} field"><button onclick="this.textContent = '${name} clicked ' + event.isTrusted">${name} button</button>${nested}`));
    },

    "/huge": () => html(page("Huge", `<h1>Huge</h1>${Array.from({ length: 4_000 }, (_, index) => `<button>Item button ${index}</button>`).join("")}<p>${"lorem ipsum ".repeat(20_000)}</p>`)),

    "/counter": () => html(page("Counter", `
      <p><button id="count" onclick="this.dataset.n = Number(this.dataset.n || 0) + 1; log('click trusted=' + event.isTrusted + ' n=' + this.dataset.n)">Count</button></p>
      <p><input aria-label="Keys" onkeydown="log('key ' + event.key + ' ctrl=' + event.ctrlKey + ' shift=' + event.shiftKey + ' trusted=' + event.isTrusted)"></p>
      <p><a href="/form">Go to form</a></p>
      <p><button onclick="if (confirm('Really delete?')) log('confirmed'); else log('cancelled')">Delete</button></p>
      <p><a href="/popup-target" target="_blank">Open popup</a></p>
      <div style="position:relative;margin:30px 0;width:200px"><button onclick="log('covered clicked')">Covered</button><div style="position:absolute;inset:0;background:rgba(0,0,0,.5)">Cookie banner</div></div>
      <p><input type="file" aria-label="Attachment" multiple onchange="log('files ' + Array.from(this.files).map((f) => f.name + ':' + f.size).join(','))"></p>
      <p><button onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Late content arrived'; document.body.append(p); }, 1200)">Load later</button></p>
      <div id="scroller" style="height:100px;overflow:auto;border:1px solid"><div style="height:1000px">Scrollable box</div></div>
      <div style="height:4000px"></div><p>Bottom of the page</p>
      ${LOG_SCRIPT}`)),

    "/popup-target": () => html(page("Popup", `<h1>Popup page</h1><button onclick="window.close()">Close me</button>`)),

    // Labels that wrap over two lines (as fonts and widths happen to make them): the center of
    // their bounding box lies between the line fragments, where a <select> sits. The custom
    // checkbox is visually hidden, so its label is what gets clicked.
    "/wrapped-labels": () => html(page("Wrapped labels", `
      <div style="position:relative;width:300px;font:16px/40px monospace">
        <span style="display:inline-block;width:200px"></span><label><input type="checkbox" name="news" style="position:absolute;opacity:0;width:1px;height:1px" onchange="log('news ' + this.checked)">Send me news</label>
        <select aria-label="Language" style="position:absolute;left:110px;top:25px;width:80px;height:30px"><option>English</option><option>German</option></select>
      </div>
      <div style="position:relative;width:300px;font:16px/40px monospace">
        <span style="display:inline-block;width:200px"></span><a href="#all" onclick="log('link')">Read all the news</a>
        <select aria-label="Region" style="position:absolute;left:110px;top:25px;width:80px;height:30px"><option>EU</option><option>US</option></select>
      </div>
      ${LOG_SCRIPT}`)),

    "/login": () => html(page("Sign in", `
      <h1>Sign in</h1>
      <form method="post" action="/login">
        <label>Username <input name="username" autocomplete="username"></label>
        <label>Password <input name="password" type="password"></label>
        <button>Sign in</button>
      </form>`)),

    "/login-error": () => html(page("Sign in", `<h1>Sign in</h1><p role="alert">Wrong username or password</p><a href="/login">Try again</a>`)),

    "/search": (request, url) => {
      if (!request.headers.get("cookie")?.includes("session=ok")) return Response.redirect(new URL("/login", url).href, 303);
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const hits = query ? ITEMS.filter((item) => item.name.toLowerCase().includes(query)) : [];
      return html(page("Search", `
        <h1>Catalog search</h1>
        <form action="/search"><input type="search" name="q" aria-label="Search catalog" value="${query}"><button>Search</button></form>
        ${query ? `<ul>${hits.map((item) => `<li><a href="/item/${item.id}">${item.name}</a></li>`).join("") || "<li>No results</li>"}</ul>` : ""}`));
    },

    "/item": (request, url) => {
      if (!request.headers.get("cookie")?.includes("session=ok")) return Response.redirect(new URL("/login", url).href, 303);
      const item = ITEMS.find((candidate) => candidate.id === url.pathname.split("/").pop());
      if (!item) return new Response("not found", { status: 404 });
      return html(page(item.name, `<h1>${item.name}</h1><dl><dt>Price</dt><dd>${item.price}</dd><dt>SKU</dt><dd>${item.sku}</dd></dl><a href="/search">Back to search</a>`));
    },
  };
}

export interface FixtureSite {
  /** http://app.test:<port> */
  origin: string;
  /** http://other.test:<port>: same server, another site (so its frames are out-of-process). */
  otherOrigin: string;
  logins: number;
  stop(): void;
}

export function startFixtureSite(): FixtureSite {
  let site!: FixtureSite;
  const server: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/login" && request.method === "POST") {
        const form = await request.formData();
        site.logins += 1;
        const ok = form.get("username") === "alice" && form.get("password") === PASSWORD;
        return new Response(null, { status: 303, headers: { location: ok ? "/search" : "/login-error", ...(ok ? { "set-cookie": "session=ok; Path=/" } : {}) } });
      }
      const handler = routes(site.otherOrigin)[url.pathname.startsWith("/item/") ? "/item" : url.pathname];
      return handler ? handler(request, url) : new Response("not found", { status: 404 });
    },
  });
  site = { origin: `http://app.test:${server.port}`, otherOrigin: `http://other.test:${server.port}`, logins: 0, stop: () => server.stop(true) };
  return site;
}
