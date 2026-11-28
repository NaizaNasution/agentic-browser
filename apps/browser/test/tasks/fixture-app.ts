// Fixture web app for the M2 task suite (docs/SPEC.md §21, §22: "90% success on the fixture task suite").
// Plain HTML and small scripts, covering what agents meet on real sites: forms and validation, sign-in with a
// cookie, a client-side app, modals, shadow DOM, same- and cross-site iframes, infinite scroll, dialogs,
// downloads, uploads, hover menus, ARIA widgets, pop-ups, search suggestions, wizards, pagination, and keyboard
// shortcuts. Every task's outcome is recorded server-side in `state`, so the suite checks what really happened.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FixtureState {
  logins: string[];
  signups: Record<string, string>[];
  orders: string[][];
  todos: { id: number; text: string; done: boolean }[];
  shadow: string[];
  partner: string[];
  opened: number[];
  uploads: { name: string; size: number }[];
  edits: string[];
  wizard: Record<string, string>[];
  palette: string[];
  editor: string[];
  fruit: string[];
  done: string[];
}

export interface FixtureApp {
  url: string;
  partnerUrl: string;
  state: FixtureState;
  close(): Promise<void>;
}

const COUNTRIES = ["Argentina", "Brazil", "Canada", "Denmark", "Egypt", "France", "Ghana", "Hungary", "India", "Japan", "Kenya", "Laos", "Mexico", "Norway", "Oman", "Peru"];

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;margin:24px;max-width:900px} .hidden{display:none} nav a{margin-right:12px}</style></head>
<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
}

const post = (path: string, body: string) => `fetch(${JSON.stringify(path)}, { method: "POST", headers: { "content-type": "application/json" }, body: ${body} })`;

function routes(state: FixtureState, partnerUrl: string): Record<string, (req: IncomingMessage, body: string, res: ServerResponse) => string | void> {
  return {
    // ---------- sign-in with a cookie ----------
    "GET /login": () =>
      page("Sign in", `<main><h1>Sign in</h1><form method="post" action="/login">
        <label>Username <input name="user" autocomplete="username" required></label>
        <label>Password <input name="pw" type="password" autocomplete="current-password" required></label>
        <button>Sign in</button></form></main>`),
    "POST /login": (_req, body, res) => {
      const f = new URLSearchParams(body);
      if (f.get("pw") === "correct horse") {
        state.logins.push(f.get("user") ?? "");
        res.writeHead(303, { location: "/dashboard", "set-cookie": `session=${encodeURIComponent(f.get("user") ?? "")}; Path=/; HttpOnly` });
        res.end();
        return;
      }
      return page("Sign in", `<main><h1>Sign in</h1><div role="alert">Wrong username or password</div><a href="/login">Try again</a></main>`);
    },
    "GET /dashboard": (req) => {
      const user = /session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      return user ? page("Dashboard", `<main><h1>Dashboard</h1><p>Welcome, ${decodeURIComponent(user)}</p></main>`) : page("Sign in required", `<main><h1>Please sign in</h1><a href="/login">Sign in</a></main>`);
    },

    // ---------- a long form ----------
    "GET /signup": () =>
      page("Sign up", `<main><h1>Create your account</h1><form method="post" action="/signup">
        <p><label>Full name <input name="name" required></label></p>
        <p><label>Email <input name="email" type="email" required></label></p>
        <p><label>Country <select name="country">${COUNTRIES.map((c) => `<option>${c}</option>`).join("")}</select></label></p>
        <fieldset><legend>Plan</legend><label><input type="radio" name="plan" value="free" checked> Free</label><label><input type="radio" name="plan" value="pro"> Pro</label></fieldset>
        <p><label>About you <textarea name="bio"></textarea></label></p>
        <p><label><input type="checkbox" name="terms" required> I accept the terms</label></p>
        <button>Create account</button></form></main>`),
    "POST /signup": (_req, body) => {
      state.signups.push(Object.fromEntries(new URLSearchParams(body)));
      return page("Welcome", `<main><h1>Account created</h1></main>`);
    },

    // ---------- shop with a confirm() ----------
    "GET /shop": () =>
      page("Shop", `<main><h1>Shop</h1><p>Cart: <span id="count">0</span> items <a href="/cart">View cart</a></p>
        <ul>${["Lamp", "Chair", "Desk"].map((p) => `<li>${p} <button aria-label="Add ${p} to cart" onclick="add('${p}')">Add to cart</button></li>`).join("")}</ul></main>`,
        `function add(p){ const c = JSON.parse(sessionStorage.cart || "[]"); c.push(p); sessionStorage.cart = JSON.stringify(c); document.getElementById("count").textContent = c.length; }
         document.getElementById("count").textContent = JSON.parse(sessionStorage.cart || "[]").length;`),
    "GET /cart": () =>
      page("Cart", `<main><h1>Your cart</h1><ul id="items"></ul><button id="checkout">Place order</button><p id="result" role="status"></p></main>`,
        `const c = JSON.parse(sessionStorage.cart || "[]"); document.getElementById("items").innerHTML = c.map((p) => "<li>" + p + "</li>").join("");
         document.getElementById("checkout").onclick = async () => {
           if (!confirm("Place an order for " + c.length + " items?")) { document.getElementById("result").textContent = "Order cancelled"; return; }
           await ${post("/api/order", "JSON.stringify(c)")}; sessionStorage.cart = "[]"; document.getElementById("result").textContent = "Order placed";
         };`),
    "POST /api/order": (_req, body) => {
      state.orders.push(JSON.parse(body));
      return "{}";
    },

    // ---------- client-side to-do app ----------
    "GET /todo": () =>
      page("Todos", `<main><h1>Todos</h1><form id="f"><input id="new" aria-label="New todo" placeholder="What needs doing?"></form><ul id="list"></ul><p id="left"></p></main>`,
        `let todos = []; const list = document.getElementById("list");
         async function load(){ todos = await (await fetch("/api/todos")).json(); render(); }
         function render(){ list.innerHTML = ""; for (const t of todos) { const li = document.createElement("li");
           li.innerHTML = '<label><input type="checkbox"' + (t.done ? " checked" : "") + '> ' + t.text + '</label> <button aria-label="Delete ' + t.text + '">×</button>';
           li.querySelector("input").onchange = async (e) => { await ${post("/api/todos/toggle", "JSON.stringify({ id: t.id, done: e.target.checked })")}; load(); };
           li.querySelector("button").onclick = async () => { await ${post("/api/todos/delete", "JSON.stringify({ id: t.id })")}; load(); };
           list.appendChild(li); }
           document.getElementById("left").textContent = todos.filter((t) => !t.done).length + " left"; }
         document.getElementById("f").onsubmit = async (e) => { e.preventDefault(); const v = document.getElementById("new").value.trim(); if (!v) return;
           document.getElementById("new").value = ""; await ${post("/api/todos/add", "JSON.stringify({ text: v })")}; load(); };
         load();`),
    "GET /api/todos": () => JSON.stringify(state.todos),
    "POST /api/todos/add": (_req, body) => {
      state.todos.push({ id: state.todos.length + 1, text: JSON.parse(body).text, done: false });
      return "{}";
    },
    "POST /api/todos/toggle": (_req, body) => {
      const { id, done } = JSON.parse(body);
      const t = state.todos.find((x) => x.id === id);
      if (t) t.done = done;
      return "{}";
    },
    "POST /api/todos/delete": (_req, body) => {
      const { id } = JSON.parse(body);
      state.todos = state.todos.filter((x) => x.id !== id);
      return "{}";
    },

    // ---------- a cookie banner covering the page ----------
    "GET /modal": () =>
      page("Welcome offer", `<main><h1>Welcome</h1><p>Read the offer, then continue.</p><a href="/modal/next">Continue</a></main>
        <div id="banner" style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><div role="dialog" aria-label="Cookie consent" style="background:#fff;margin:120px auto;width:420px;padding:20px">
        <p>We use cookies.</p><button onclick="document.getElementById('banner').remove()">Accept all</button> <button onclick="document.getElementById('banner').remove()">Reject all</button></div></div>`),
    "GET /modal/next": () => {
      state.done.push("modal");
      return page("Offer", `<main><h1>The offer</h1></main>`);
    },

    // ---------- shadow DOM ----------
    "GET /shadow": () =>
      page("Newsletter", `<main><h1>Newsletter</h1><news-form></news-form><p id="msg" role="status"></p></main>`,
        `customElements.define("news-form", class extends HTMLElement { connectedCallback(){ const r = this.attachShadow({ mode: "open" });
           r.innerHTML = '<label>Email address <input id="e" type="email"></label> <button id="b">Subscribe</button>';
           r.getElementById("b").onclick = async () => { await ${post("/api/subscribe", "JSON.stringify({ email: r.getElementById('e').value })")}; document.getElementById("msg").textContent = "Subscribed"; }; } });`),
    "POST /api/subscribe": (_req, body) => {
      state.shadow.push(JSON.parse(body).email);
      return "{}";
    },

    // ---------- iframes ----------
    "GET /frames": () =>
      page("Partners", `<main><h1>Partners</h1><iframe src="/frames/inner" title="Local widget" width="400" height="80"></iframe>
        <iframe src="${partnerUrl}/widget" title="Partner form" width="500" height="120"></iframe></main>`),
    "GET /frames/inner": () => page("Inner", `<button onclick="this.textContent='Liked'">Like</button>`),

    // ---------- infinite scroll ----------
    "GET /feed": () =>
      page("Feed", `<main><h1>Feed</h1><ul id="list"></ul><div id="more" style="height:40px">Loading more…</div></main>`,
        `let n = 0; const list = document.getElementById("list");
         function more(){ for (let i = 0; i < 12 && n < 80; i++) { n++; const li = document.createElement("li"); li.style.height = "60px";
           li.innerHTML = "Story " + n + ' <a href="/feed/' + n + '">Read story ' + n + "</a>"; list.appendChild(li); } }
         more(); new IntersectionObserver((e) => { if (e[0].isIntersecting) setTimeout(more, 150); }).observe(document.getElementById("more"));`),
    "GET /feed/*": (req) => {
      const id = Number((req.url ?? "").split("/").pop());
      state.opened.push(id);
      return page(`Story ${id}`, `<main><h1>Story ${id}</h1></main>`);
    },

    // ---------- dialogs ----------
    // (No prompt(): Electron doesn't support it; it returns null without showing anything.)
    "GET /dialogs": () =>
      page("Greeter", `<main><h1>Greeter</h1><button id="a">Show notice</button> <button id="t">Remind me in a moment</button><p id="out" role="status"></p></main>`,
        `document.getElementById("a").onclick = () => { alert("Maintenance tonight"); document.getElementById("out").textContent = "Notice seen"; };
         document.getElementById("t").onclick = () => { document.getElementById("out").textContent = "Reminder set";
           setTimeout(() => { const ok = confirm("Time for your break?"); document.getElementById("out").textContent = ok ? "Break started" : "Break skipped"; }, 600); };`),

    // ---------- downloads and uploads ----------
    "GET /export": () => page("Export", `<main><h1>Export</h1><a href="/export/report.csv">Download CSV report</a></main>`),
    "GET /export/report.csv": (_req, _b, res) => {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
      res.end("country,visits\nKenya,42\nJapan,17\n");
    },
    "GET /upload": () =>
      page("Upload", `<main><h1>Upload your CV</h1><form method="post" action="/upload" enctype="multipart/form-data">
        <label>CV file <input type="file" name="cv"></label> <button>Send</button></form></main>`),
    "POST /upload": (req, body) => {
      const name = /filename="([^"]*)"/.exec(body)?.[1] ?? "";
      const boundary = /boundary=(.+)$/.exec(req.headers["content-type"] ?? "")?.[1] ?? "";
      const part = body.split(`--${boundary}`).find((p) => p.includes(`filename="`)) ?? "";
      const content = part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
      state.uploads.push({ name, size: Buffer.byteLength(content, "latin1") }); // the body was read as latin1: one char per byte
      return page("Uploaded", `<main><h1>Thanks, we got ${name}</h1></main>`);
    },

    // ---------- hover menu ----------
    "GET /menu": () =>
      page("Menu", `<style>.sub{display:none;position:absolute;background:#eee;padding:8px} .top:hover .sub{display:block}</style>
        <nav aria-label="Site"><span class="top" style="position:relative;padding:8px" tabindex="0">Account ▾<span class="sub"><a href="/menu/settings">Settings</a><br><a href="/menu/billing">Billing</a></span></span></nav><main><h1>Home</h1></main>`),
    "GET /menu/settings": () => {
      state.done.push("menu-settings");
      return page("Settings", `<main><h1>Settings</h1></main>`);
    },

    // ---------- ARIA combobox, native select, tabs ----------
    "GET /widgets": () =>
      page("Widgets", `<main><h1>Preferences</h1>
        <label id="fl">Favorite fruit</label><div role="combobox" aria-labelledby="fl" aria-expanded="false" aria-controls="fruits" tabindex="0" id="cb">Choose…</div>
        <ul role="listbox" id="fruits" hidden>${["Apple", "Mango", "Papaya"].map((f) => `<li role="option" tabindex="-1">${f}</li>`).join("")}</ul>
        <p><label>Language <select id="lang"><option>English</option><option>Indonesian</option><option>Japanese</option></select></label></p>
        <div role="tablist" aria-label="Account"><button role="tab" aria-selected="true" aria-controls="p1" id="t1">Profile</button><button role="tab" aria-selected="false" aria-controls="p2" id="t2">Billing</button></div>
        <div role="tabpanel" id="p1">Name: Ana</div><div role="tabpanel" id="p2" hidden>Plan: Pro, renews 1 March</div>
        <button id="save">Save preferences</button><p id="out" role="status"></p></main>`,
        `const cb = document.getElementById("cb"), lb = document.getElementById("fruits");
         cb.onclick = () => { lb.hidden = !lb.hidden; cb.setAttribute("aria-expanded", String(!lb.hidden)); };
         for (const o of lb.children) o.onclick = () => { cb.textContent = o.textContent; lb.hidden = true; cb.setAttribute("aria-expanded", "false"); };
         for (const t of document.querySelectorAll("[role=tab]")) t.onclick = () => { for (const u of document.querySelectorAll("[role=tab]")) { u.setAttribute("aria-selected", String(u === t)); document.getElementById(u.getAttribute("aria-controls")).hidden = u !== t; } };
         document.getElementById("save").onclick = async () => { await ${post("/api/prefs", "JSON.stringify({ fruit: cb.textContent, lang: document.getElementById('lang').value })")}; document.getElementById("out").textContent = "Saved"; };`),
    "POST /api/prefs": (_req, body) => {
      const p = JSON.parse(body);
      state.fruit.push(`${p.fruit}/${p.lang}`);
      return "{}";
    },

    // ---------- pop-up ----------
    "GET /popup": () => page("Help center", `<main><h1>Help</h1><a href="/popup/article" target="_blank">Open the refund policy</a></main>`),
    "GET /popup/article": () => page("Refund policy", `<main><h1>Refund policy</h1><p>Refunds within 30 days.</p></main>`),

    // ---------- search with suggestions ----------
    "GET /search": () =>
      page("Search", `<main><h1>Find a country</h1><input id="q" role="searchbox" aria-label="Search countries" autocomplete="off"><ul id="sugg" role="listbox" aria-label="Suggestions"></ul></main>`,
        `let timer; document.getElementById("q").oninput = (e) => { clearTimeout(timer); timer = setTimeout(async () => {
           const list = await (await fetch("/api/suggest?q=" + encodeURIComponent(e.target.value))).json();
           document.getElementById("sugg").innerHTML = list.map((c) => '<li role="option"><a href="/country/' + c + '">' + c + "</a></li>").join(""); }, 250); };`),
    "GET /api/suggest": (req) => {
      const q = new URL(req.url ?? "", "http://x").searchParams.get("q")?.toLowerCase() ?? "";
      return JSON.stringify(q ? COUNTRIES.filter((c) => c.toLowerCase().startsWith(q)) : []);
    },
    "GET /country/*": (req) => {
      const c = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      state.done.push(`country:${c}`);
      return page(c, `<main><h1>${c}</h1></main>`);
    },

    // ---------- wizard with a disabled Next ----------
    "GET /wizard": () =>
      page("Booking", `<main><h1>Book a room</h1>
        <section id="s1"><h2>Step 1: Dates</h2><label>Nights <input id="nights" type="number" min="1"></label> <button id="n1" disabled>Next</button></section>
        <section id="s2" hidden><h2>Step 2: Guest</h2><label>Guest name <input id="guest"></label> <button id="n2" disabled>Next</button></section>
        <section id="s3" hidden><h2>Step 3: Confirm</h2><label><input type="checkbox" id="agree"> I agree to the house rules</label> <button id="book" disabled>Book now</button></section>
        <p id="out" role="status"></p></main>`,
        `const $ = (id) => document.getElementById(id);
         $("nights").oninput = () => ($("n1").disabled = !($("nights").value > 0)); $("n1").onclick = () => { $("s1").hidden = true; $("s2").hidden = false; };
         $("guest").oninput = () => ($("n2").disabled = !$("guest").value.trim()); $("n2").onclick = () => { $("s2").hidden = true; $("s3").hidden = false; };
         $("agree").onchange = () => ($("book").disabled = !$("agree").checked);
         $("book").onclick = async () => { await ${post("/api/book", "JSON.stringify({ nights: $('nights').value, guest: $('guest').value })")}; $("out").textContent = "Booked"; };`),
    "POST /api/book": (_req, body) => {
      state.wizard.push(JSON.parse(body));
      return "{}";
    },

    // ---------- paginated table ----------
    "GET /table": (req) => {
      const p = Number(new URL(req.url ?? "", "http://x").searchParams.get("page") ?? "1");
      const rows = COUNTRIES.slice((p - 1) * 5, p * 5);
      return page(`Countries page ${p}`, `<main><h1>Countries</h1><table><thead><tr><th>Country</th><th>Action</th></tr></thead><tbody>
        ${rows.map((c) => `<tr><td>${c}</td><td><a href="/table/edit/${c}" aria-label="Edit ${c}">Edit</a></td></tr>`).join("")}</tbody></table>
        <nav aria-label="Pages">${p > 1 ? `<a href="/table?page=${p - 1}">Previous</a>` : ""} <span>Page ${p}</span> ${p * 5 < COUNTRIES.length ? `<a href="/table?page=${p + 1}">Next page</a>` : ""}</nav></main>`);
    },
    "GET /table/edit/*": (req) => {
      const c = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
      state.edits.push(c);
      return page(`Edit ${c}`, `<main><h1>Editing ${c}</h1></main>`);
    },

    // ---------- keyboard shortcut and command palette ----------
    "GET /palette": () =>
      page("Editor", `<main><h1>Document</h1><p>Press Control+K for commands.</p><div id="pal" role="dialog" aria-label="Command palette" hidden>
        <input id="cmd" aria-label="Command"><ul id="opts" role="listbox"></ul></div><p id="out" role="status"></p></main>`,
        `const cmds = ["Dark mode", "Light mode", "Print"]; const pal = document.getElementById("pal"), cmd = document.getElementById("cmd");
         document.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden = false; cmd.focus(); } });
         cmd.oninput = () => { document.getElementById("opts").innerHTML = cmds.filter((c) => c.toLowerCase().includes(cmd.value.toLowerCase())).map((c) => '<li role="option">' + c + "</li>").join(""); };
         cmd.onkeydown = async (e) => { if (e.key !== "Enter") return; const first = document.querySelector("#opts li"); if (!first) return;
           await ${post("/api/palette", "JSON.stringify({ cmd: first.textContent })")}; pal.hidden = true; document.getElementById("out").textContent = "Ran " + first.textContent; };`),
    "POST /api/palette": (_req, body) => {
      state.palette.push(JSON.parse(body).cmd);
      return "{}";
    },

    // ---------- rich-text editor ----------
    "GET /editor": () =>
      page("Notes", `<main><h1>Notes</h1><div id="ed" contenteditable="true" aria-label="Note" style="border:1px solid #999;min-height:60px">Draft</div><button id="save">Save note</button><p id="out" role="status"></p></main>`,
        `document.getElementById("save").onclick = async () => { await ${post("/api/note", "JSON.stringify({ text: document.getElementById('ed').innerText })")}; document.getElementById("out").textContent = "Note saved"; };`),
    "POST /api/note": (_req, body) => {
      state.editor.push(JSON.parse(body).text);
      return "{}";
    },

    // ---------- content that arrives late ----------
    "GET /slow": () =>
      page("Report", `<main><h1>Report</h1><p id="s">Generating…</p></main>`,
        `setTimeout(() => { document.getElementById("s").innerHTML = 'Ready. <a href="/slow/done">Open the report</a>'; }, 1500);`),
    "GET /slow/done": () => {
      state.done.push("slow");
      return page("Report ready", `<main><h1>Quarterly report</h1></main>`);
    },

    // ---------- disclosure ----------
    "GET /faq": () => page("FAQ", `<main><h1>FAQ</h1><details><summary>What is the return window?</summary><p>You can return items within 45 days.</p></details></main>`),

    // ---------- history ----------
    "GET /a": () => page("Page A", `<main><h1>Page A</h1><a href="/b">Go to B</a></main>`),
    "GET /b": () => page("Page B", `<main><h1>Page B</h1><a href="/a">Go to A</a></main>`),

    // ---------- an element that is replaced on every render ----------
    "GET /rerender": () =>
      page("Counter", `<main><h1>Counter</h1><div id="root"></div></main>`,
        `let n = 0; function render(){ document.getElementById("root").innerHTML = '<p role="status">Count: ' + n + '</p><button id="inc">Increment</button>';
           document.getElementById("inc").onclick = async () => { n++; await ${post("/api/count", "JSON.stringify({ n })")}; render(); }; } render();`),
    "POST /api/count": (_req, body) => {
      state.done.push(`count:${JSON.parse(body).n}`);
      return "{}";
    },
  };
}

/** The partner site for cross-site iframes. */
function partnerRoutes(state: FixtureState): Record<string, (req: IncomingMessage, body: string, res: ServerResponse) => string | void> {
  return {
    "GET /widget": () =>
      page("Partner", `<form method="post" action="/widget"><label>Partner code <input name="code"></label> <button>Redeem</button></form>`),
    "POST /widget": (_req, body) => {
      state.partner.push(new URLSearchParams(body).get("code") ?? "");
      return page("Partner", `<p>Code redeemed</p>`);
    },
  };
}

function serve(table: () => Record<string, (req: IncomingMessage, body: string, res: ServerResponse) => string | void>): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const path = (req.url ?? "/").split("?")[0]!;
      const routes = table();
      const exact = routes[`${req.method} ${path}`];
      const wildcard = Object.entries(routes).find(([k]) => k.endsWith("/*") && `${req.method} ${path}`.startsWith(k.slice(0, -1)))?.[1];
      const handler = exact ?? wildcard;
      if (!handler) {
        res.writeHead(404, { "content-type": "text/html" });
        res.end(page("Not found", "<h1>Not found</h1>"));
        return;
      }
      const out = handler(req, body, res);
      if (typeof out === "string" && !res.headersSent) {
        res.writeHead(200, { "content-type": out.startsWith("<!doctype") ? "text/html; charset=utf-8" : "application/json" });
        res.end(out);
      }
    });
  });
}

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));

export async function startFixtureApp(): Promise<FixtureApp> {
  const state: FixtureState = { logins: [], signups: [], orders: [], todos: [], shadow: [], partner: [], opened: [], uploads: [], edits: [], wizard: [], palette: [], editor: [], fruit: [], done: [] };
  // The partner runs on "localhost" and the app on "127.0.0.1": different sites, so the partner iframe is out of process.
  const partner = serve(() => partnerRoutes(state));
  const partnerPort = await listen(partner);
  const partnerUrl = `http://localhost:${partnerPort}`;
  const app = serve(() => routes(state, partnerUrl));
  const port = await listen(app);
  return {
    url: `http://127.0.0.1:${port}`,
    partnerUrl,
    state,
    close: () => Promise.all([new Promise<void>((r) => app.close(() => r())), new Promise<void>((r) => partner.close(() => r()))]).then(() => {}),
  };
}
