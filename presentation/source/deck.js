// Builds presentation/Fastermall_Backend_Explained.pptx
const path = require('path');
const fs = require('fs');
const pptxgen = require('pptxgenjs');
const { applyTheme } = require(process.argv[3]);

const OUT = process.argv[2];
const IMG = path.join(OUT, 'images');
const FILE = path.join(OUT, 'Fastermall_Backend_Explained.pptx');

const THEME = {
  name: 'Fastermall Teal',
  headFontFace: 'Cambria',
  bodyFontFace: 'Calibri',
  colors: {
    dk1: '1D2B33', lt1: 'FFFFFF', dk2: '0B4F5C', lt2: 'F0F8F9',
    accent1: '1F7A8C', accent2: 'E07B2A', accent3: '2E7D4F', accent4: '5B4B9A', accent5: 'B83227', accent6: 'B7791F',
    hlink: '1F7A8C', folHlink: '5B4B9A',
  },
};
const HEX = THEME.colors;

const pres = new pptxgen();
pres.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5
pres.title = 'Fastermall Backend Explained';
pres.subject = 'How the backend works, its workflows, and an audit';
pres.author = 'Fastermall';
pres.company = 'Fastermall';
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
const C = pres.SchemeColor;

const W = 13.333, H = 7.5, M = 0.6;
const FOOT = 'Fastermall backend · explained & audited · 13 Nov 2026';

// ── layouts ──────────────────────────────────────────────────────────
pres.defineSlideMaster({
  title: 'TITLE_DARK',
  background: { color: HEX.dk2 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 2.0, w: 10.5, h: 1.8, fontSize: 48, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: 'Title' } },
    { placeholder: { options: { name: 'body', type: 'body', x: M, y: 4.0, w: 10.5, h: 1.4, fontSize: 20, color: C.background2, valign: 'top', margin: 0 }, text: 'Subtitle' } },
  ],
});
pres.defineSlideMaster({
  title: 'SECTION_DARK',
  background: { color: HEX.dk2 },
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: 2.2, y: 2.5, w: 10, h: 1.2, fontSize: 40, bold: true, color: C.background1, valign: 'bottom', align: 'left', margin: 0 }, text: 'Section' } },
    { placeholder: { options: { name: 'body', type: 'body', x: 2.2, y: 3.85, w: 10, h: 1.2, fontSize: 20, color: C.background2, valign: 'top', margin: 0 }, text: 'What this part covers' } },
  ],
  slideNumber: { x: 12.2, y: 6.95, w: 0.6, h: 0.3, fontSize: 10, color: C.background2, align: 'right' },
});
pres.defineSlideMaster({
  title: 'CONTENT',
  background: { color: HEX.lt1 },
  margin: [0.5, 0.6, 0.7, 0.6],
  objects: [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.35, w: W - 2 * M, h: 0.85, fontSize: 32, bold: true, color: C.text2, valign: 'middle', align: 'left', margin: 0 }, text: 'Title' } },
    { text: { text: FOOT, options: { x: M, y: 6.95, w: 8, h: 0.3, fontSize: 10, color: '5B6B73', margin: 0 } } },
  ],
  slideNumber: { x: 12.2, y: 6.95, w: 0.53, h: 0.3, fontSize: 10, color: '5B6B73', align: 'right' },
});

let section = '';
const sec = (title) => { section = title; pres.addSection({ title }); };
const slide = (master = 'CONTENT') => pres.addSlide({ masterName: master, sectionTitle: section });
const title = (s, t) => s.addText(t, { placeholder: 'title' });

function imgSize(name) {
  const svg = fs.readFileSync(path.join(IMG, name + '.svg'), 'utf8');
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  return { w: +m[1], h: +m[2] };
}
// Fit an image into a box, centred horizontally, top-aligned.
function image(s, name, box, alt) {
  const { w, h } = imgSize(name);
  const r = Math.min(box.w / w, box.h / h);
  const iw = w * r, ih = h * r;
  s.addImage({ path: path.join(IMG, name + '.png'), x: box.x + (box.w - iw) / 2, y: box.y, w: iw, h: ih, altText: alt, objectName: name });
  return box.y + ih;
}
function caption(s, text, y, opts = {}) {
  s.addText(text, { x: M, y, w: W - 2 * M, h: 0.45, fontSize: 15, italic: true, color: C.text2, align: 'center', margin: 0, isTextBox: true, ...opts });
}
function card(s, x, y, w, h, head, body, col, opts = {}) {
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: opts.fill || HEX.lt2 }, line: { color: col, width: 1.25 }, objectName: 'card ' + head });
  if (opts.num !== undefined) {
    s.addShape(pres.shapes.OVAL, { x: x + 0.22, y: y + 0.22, w: 0.5, h: 0.5, fill: { color: col }, line: { color: col } });
    s.addText(String(opts.num), { x: x + 0.22, y: y + 0.22, w: 0.5, h: 0.5, fontSize: 16, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0, isTextBox: true });
  }
  const tx = x + (opts.num !== undefined ? 0.85 : 0.25);
  s.addText(head, { x: tx, y: y + 0.18, w: w - (tx - x) - 0.2, h: 0.55, fontSize: opts.headSize || 18, bold: true, color: col, valign: 'middle', margin: 0, isTextBox: true });
  s.addText(body, { x: x + 0.25, y: y + 0.8, w: w - 0.45, h: h - 0.95, fontSize: opts.bodySize || 14, color: C.text1, valign: 'top', margin: 0, isTextBox: true, paraSpaceAfter: 4 });
}
const IMGBOX = { x: M, y: 1.3, w: W - 2 * M, h: 5.05 };

// ════════════════════════════════════════════════════════════════════
sec('Introduction');
{
  const s = slide('TITLE_DARK');
  s.addText('How the Fastermall backend works', { placeholder: 'title' });
  s.addText('A plain-English tour of the system behind the Customer app, the Delivery app and the Admin console, with a full audit and recommendations.', { placeholder: 'body' });
  s.addText('Prepared 13 November 2026 · based on the main branch at commit c26445c', { x: M, y: 6.6, w: 10, h: 0.4, fontSize: 13, color: HEX.lt2, margin: 0, isTextBox: true });
  s.addNotes('Welcome. This deck explains the Fastermall backend to people who do not write code. Every picture in it is also saved separately in the images folder. The last part is an audit: what is strong, what needs attention, and what to do next.');
}
{
  const s = slide();
  title(s, 'What this deck covers');
  const parts = [
    ['The big picture', 'What a backend is, who uses it, and how its parts connect', HEX.accent1],
    ['How work flows', 'Orders, payments, deliveries, laundry and new partners, step by step', HEX.accent2],
    ['Safety and data', 'Where information lives, how it is protected, how code goes live', HEX.accent4],
    ['Audit and next steps', 'Grades, findings in plain English, and a to-do list', HEX.accent5],
  ];
  parts.forEach(([h, b, col], i) => {
    const x = M + i * 3.07;
    card(s, x, 1.6, 2.85, 2.5, h, b, col, { num: i + 1, bodySize: 15 });
  });
  s.addText('No coding knowledge needed. Technical words are explained in the glossary at the end.', { x: M, y: 4.5, w: W - 2 * M, h: 0.5, fontSize: 16, italic: true, color: C.text2, margin: 0, isTextBox: true });
  s.addNotes('Four parts. If you only have five minutes, read the restaurant picture (slide 4), the order journey, and the audit scorecard.');
}

// ════════════════════════════════════════════════════════════════════
sec('The big picture');
{
  const s = slide('SECTION_DARK');
  s.addText('Part 1 · The big picture', { placeholder: 'title' });
  s.addText('What the backend is, who uses it, and how the pieces fit together', { placeholder: 'body' });
}
{
  const s = slide();
  title(s, 'The backend is the kitchen behind the apps');
  const y = image(s, '01-restaurant-analogy', IMGBOX, 'Restaurant analogy: apps are the dining room, the backend is the kitchen, the database is the pantry, outside services are helpers');
  caption(s, 'The apps never touch the stored data directly. They ask the backend, which checks every request first.', y + 0.1);
  s.addNotes('Think of a restaurant. Customers sit in the dining room (the apps on their phones). They never walk into the pantry (the database). They hand an order to the kitchen (the backend), which checks it, works out the price, cooks it, and sends back the result. The kitchen also uses outside helpers: Paystack takes the money, email and phone push carry messages, Supabase storage keeps photos, Google confirms who someone is.');
}
{
  const s = slide();
  title(s, 'The backend by the numbers');
  const stats = [
    ['18', 'departments (modules)', 'each owns one area, such as orders or laundry', HEX.accent1],
    ['192', 'doors (API routes)', 'the exact requests the apps are allowed to make', HEX.accent2],
    ['42', 'tables of data', 'customers, products, orders, payments and more', HEX.accent4],
    ['39', 'database updates', 'migrations, each one adding to the structure safely', HEX.accent6],
    ['708', 'automatic tests', 'all passing on 13 Nov 2026, in 49 test files', HEX.accent3],
    ['150', 'saved changes (commits)', 'since the project started on 10 Sep 2026', HEX.accent5],
  ];
  stats.forEach(([n, l, d, col], i) => {
    const x = M + (i % 3) * 4.1, y = 1.45 + Math.floor(i / 3) * 2.65;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: 3.85, h: 2.4, rectRadius: 0.12, fill: { color: HEX.lt2 }, line: { color: HEX.lt2 }, objectName: 'stat ' + l });
    s.addText(n, { x: x + 0.3, y: y + 0.2, w: 3.3, h: 1.0, fontSize: 54, bold: true, color: col, fontFace: THEME.headFontFace, margin: 0, isTextBox: true });
    s.addText(l, { x: x + 0.3, y: y + 1.2, w: 3.3, h: 0.4, fontSize: 17, bold: true, color: C.text1, margin: 0, isTextBox: true });
    s.addText(d, { x: x + 0.3, y: y + 1.6, w: 3.3, h: 0.65, fontSize: 14, color: '5B6B73', margin: 0, isTextBox: true, valign: 'top' });
  });
  s.addNotes('Built with NestJS (a TypeScript framework for servers), Prisma (the tool that talks to the database) and Supabase Postgres (the hosted database). It runs on Render. Numbers were counted directly from the code on 13 November 2026.');
}
{
  const s = slide();
  title(s, 'Five kinds of people use it');
  const y = image(s, '02-who-uses-it', IMGBOX, 'The five roles: customer, delivery partner, vendor, laundry staff, admin, and what each can do');
  caption(s, 'Each person signs in with a role. The role decides which doors (routes) they may open.', y + 0.1);
  s.addNotes('Customers have their own accounts. Everyone else is staff, with one of four roles: delivery partner, vendor, laundry staff or admin. The backend checks the role on every request, so a customer can never open an admin screen, and laundry staff only see orders for their own laundry.');
}
{
  const s = slide();
  title(s, 'How the pieces connect');
  const y = image(s, '03-architecture-map', IMGBOX, 'Architecture: three apps pass through a front door of checks into 18 modules, which use the database, storage, Paystack, email, push and Google');
  caption(s, 'One program (a “modular monolith”): separate departments inside, deployed as a single unit.', y + 0.1);
  s.addNotes('Left: the three apps. Middle-left: the front door, where every request is checked. Centre: the 18 departments grouped by purpose. Right: the outside services. A modular monolith is one program with clear internal walls. It is simpler to run than many small services and can be split later if needed.');
}
{
  const s = slide();
  title(s, 'What each department does');
  const rows = [
    ['identity', 'Customer sign-up, email codes, login, Google sign-in'],
    ['staff', 'Staff logins, sessions, password resets, deactivation'],
    ['partner-applications', 'People apply to deliver; admins approve or reject'],
    ['addresses', 'Customers’ saved delivery addresses'],
    ['marketplace', 'Products, categories, photos, reviews'],
    ['food', 'Food vendors, menus, choices and add-ons'],
    ['orders', 'Baskets become orders; prices, stock, windows, cancelling'],
    ['preorders', 'Custom design requests, quotes, accept or decline'],
    ['laundry', 'Laundry vendors, price lists, 13-stage orders, ratings'],
  ];
  const rows2 = [
    ['logistics', 'Delivery jobs, handover codes, wallet, payouts, documents'],
    ['payments', 'Paystack checkout, verification, refunds'],
    ['notifications', 'In-app messages, phone push, announcements'],
    ['support', 'Help tickets and replies'],
    ['promotions', 'Pop-up offers in the app, scheduled by admins'],
    ['faq', 'Frequently asked questions'],
    ['admin', 'Dashboards, lists, revenue, audit log'],
    ['settings', 'Fees, maintenance mode, WhatsApp number'],
    ['app-config', 'Minimum app versions, support contacts, links'],
  ];
  const mk = (rs) => [
    [{ text: 'Department', options: { bold: true, color: 'FFFFFF', fill: { color: HEX.dk2 } } }, { text: 'In plain English', options: { bold: true, color: 'FFFFFF', fill: { color: HEX.dk2 } } }],
    ...rs.map(([a, b], i) => [{ text: a, options: { bold: true, color: HEX.dk2, fill: { color: i % 2 ? 'FFFFFF' : HEX.lt2 } } }, { text: b, options: { fill: { color: i % 2 ? 'FFFFFF' : HEX.lt2 } } }]),
  ];
  const topt = { fontSize: 13, color: HEX.dk1, border: { type: 'none' }, margin: [3, 6, 3, 6], valign: 'middle', rowH: 0.47 };
  s.addTable(mk(rows), { x: M, y: 1.35, w: 5.95, colW: [1.95, 4.0], ...topt, objectName: 'departments table 1' });
  s.addTable(mk(rows2), { x: 6.78, y: 1.35, w: 5.95, colW: [1.6, 4.35], ...topt, objectName: 'departments table 2' });
  s.addNotes('Each department lives in its own folder under src/modules. Inside each: a controller (the list of doors), a service (the rules), and DTOs (the shape of allowed forms). Shared tools such as login checks, the audit log and error formatting live in src/shared.');
}
{
  const s = slide();
  title(s, 'What happens on every tap');
  const y = image(s, '04-request-journey', IMGBOX, 'Ten checkpoints every request passes, from tracking number to audit log');
  caption(s, 'Steps 3 to 6 are the gatekeepers. If any says no, nothing is changed.', y + 0.1);
  s.addNotes('Every time someone taps a button, the app sends a request. It gets a tracking number, passes a speed limit (to stop guessing attacks), proves who it is with a login token, proves it is allowed, and has its form checked. Only then does the department do the work. Every answer has the same tidy shape, and every change made by an admin is written to a logbook.');
}

// ════════════════════════════════════════════════════════════════════
sec('How work flows');
{
  const s = slide('SECTION_DARK');
  s.addText('Part 2 · How work flows', { placeholder: 'title' });
  s.addText('The main journeys through the system, step by step', { placeholder: 'body' });
}
{
  const s = slide();
  title(s, 'Journey 1: an order, from basket to doorstep');
  image(s, '05-order-lifecycle', { x: M, y: 1.25, w: W - 2 * M, h: 5.6 }, 'Seven steps of an order with side paths for unpaid orders, customer cancellation, and delivery windows');
  s.addNotes('The app only sends what was picked. The backend looks up real prices, adds the delivery fee (a vendor fee for food, a flat admin-set fee for marketplace), holds the stock, picks a delivery window and makes a secret 6-digit handover code. Unpaid orders are cleaned up automatically every 5 minutes. A customer can cancel until preparation starts, and a paid order is then refunded automatically.');
}
{
  const s = slide();
  title(s, 'Journey 2: paying safely with Paystack');
  const y = image(s, '06-payment-flow', { x: M, y: 1.25, w: W - 2 * M, h: 5.15 }, 'Sequence of a payment between the customer app, the backend and Paystack');
  caption(s, 'Cash was removed in November 2026. Only Mobile Money and card are accepted.', y + 0.08);
  s.addNotes('The key safety ideas: the amount always comes from the saved order, not from the phone; Paystack’s message is checked with a secret signature; the backend then asks Paystack directly to confirm; and the amount and currency must match exactly. A payment can only be marked paid once, so a delivery is never created twice.');
}
{
  const s = slide();
  title(s, 'Journey 3: a delivery job');
  image(s, '07-delivery-flow', { x: M, y: 1.25, w: W - 2 * M, h: 5.6 }, 'Delivery job statuses, the handover code, who gets jobs, and how partners are paid');
  s.addNotes('Once payment is proven, the job appears for partners. The first to claim it wins, which is done inside a database transaction so two partners can never both get it. The job can only move forward one step at a time. Delivery is only complete when the partner enters the customer’s 6-digit code. Each delivery adds a fixed earning to the partner’s wallet; partners request a cash-out and an admin pays it.');
}
{
  const s = slide();
  title(s, 'Journey 4: a laundry order');
  image(s, '08-laundry-flow', { x: M, y: 1.25, w: W - 2 * M, h: 5.6 }, 'The 13 laundry stages and how multiple laundries work');
  s.addNotes('Since 11 November 2026 the app supports many laundries. All earlier data was moved onto “Fastermall Laundry”. Customers pick an approved, open laundry. Staff are tied to one laundry and only see its orders. Commission and payouts to laundries are not built yet; only the commission rate is stored.');
}
{
  const s = slide();
  title(s, 'Journey 5: a new delivery partner joins');
  const y = image(s, '09-partner-onboarding', IMGBOX, 'Seven steps from application to going online');
  caption(s, 'Added 12 Nov 2026: applications, approval emails, setup codes, and calling the customer.', y + 0.1);
  s.addNotes('New this week: anyone can apply from the Delivery app. When an admin approves, an account is created and a one-time setup code is emailed, so nobody ever handles the partner’s password. Document checks can be made compulsory with one setting (PARTNER_REQUIRE_VERIFICATION). Also new: the partner carrying an order can see the customer’s phone number to call them.');
}
{
  const s = slide();
  title(s, 'Other journeys in brief');
  const cards = [
    ['Custom pre-orders', 'Customer asks for a design or something custom, adds photos. Admin sends a price and date. Customer accepts or declines. Admin marks it fulfilled. Paying for it is not built yet.', HEX.accent2],
    ['Support tickets', 'Customer opens a ticket and can add messages. Admin replies; the customer is notified. Closed tickets refuse replies.', HEX.accent1],
    ['Promotions', 'Admins create scheduled pop-up offers with a button (product, category, vendor or web link) and can announce them by push, at most once every 12 hours.', HEX.accent4],
    ['FAQ and WhatsApp', 'Public list of questions by category. A WhatsApp contact number is set by admins and shown in the app as a link.', HEX.accent3],
  ];
  cards.forEach(([h, b, col], i) => card(s, M + (i % 2) * 6.15, 1.4 + Math.floor(i / 2) * 2.7, 5.95, 2.45, h, b, col, { bodySize: 15 }));
  s.addNotes('These smaller journeys follow the same pattern: the app asks, the backend checks the role and the rules, saves the change, and posts news so the right person gets a notification.');
}
{
  const s = slide();
  title(s, 'How departments tell each other news');
  const y = image(s, '10-event-bus', IMGBOX, 'Event bus: departments post events, notifications, payments and logistics listen');
  caption(s, 'Loose coupling: a department can change inside without breaking the others.', y + 0.1);
  s.addNotes('Instead of departments calling each other directly, they post announcements such as “order created” or “payment successful”. Others listen and react. For example, when a payment succeeds, Logistics opens the delivery job and Notifications tells the customer. This keeps the code tidy and easy to extend.');
}

// ════════════════════════════════════════════════════════════════════
sec('Safety and data');
{
  const s = slide('SECTION_DARK');
  s.addText('Part 3 · Safety and data', { placeholder: 'title' });
  s.addText('Where information is kept, how it is protected, and how new code goes live', { placeholder: 'body' });
}
{
  const s = slide();
  title(s, 'Where information lives: 42 tables in 6 groups');
  const y = image(s, '11-data-map', IMGBOX, 'The 42 database tables grouped into people, catalog, orders, laundry, delivery and money, talking and running');
  caption(s, 'A table is like a spreadsheet tab: one row per customer, order, payment, and so on.', y + 0.1);
  s.addNotes('All tables are defined in one file, prisma/schema.prisma. Changes to the structure are made with migrations: small, dated scripts in prisma/migrations that are applied in order. All 39 so far only add things, so nothing existing is lost.');
}
{
  const s = slide();
  title(s, 'Layers of protection');
  const y = image(s, '12-security-layers', IMGBOX, 'Five protective layers around the data, plus extra safeguards');
  caption(s, 'Secrets (passwords, keys) live only in Render settings and a local .env file that Git ignores.', y + 0.1);
  s.addNotes('Security works like layers of an onion. Speed limits stop guessing. Login tokens prove identity, and staff sessions can be cut off instantly. Roles limit what each person can do. Strict form checks refuse unexpected data. Business rules make sure you only see your own things. Passwords and delivery codes are never stored in readable form. We checked the Git history: the real .env file with secrets has never been committed.');
}
{
  const s = slide();
  title(s, 'How new code goes live');
  const y = image(s, '14-deploy-flow', IMGBOX, 'Seven steps from writing code to a live smoke test');
  caption(s, 'Full checklist: DEPLOYMENT.md in the project folder.', y + 0.1);
  s.addNotes('The team works directly on the main branch. Before every release: back up the database, run the tests, then Render builds the code, applies database migrations, starts the server, and someone runs the quick checks listed in DEPLOYMENT.md.');
}

// ════════════════════════════════════════════════════════════════════
sec('Audit');
{
  const s = slide('SECTION_DARK');
  s.addText('Part 4 · Audit', { placeholder: 'title' });
  s.addText('An independent check of the code on 13 November 2026: what is strong, what needs fixing, and in what order', { placeholder: 'body' });
}
{
  const s = slide();
  title(s, 'How the audit was done');
  const steps = [
    ['Read the code', 'Entry point, all 18 modules, login checks, payments, orders, delivery, shared tools'],
    ['Ran every test', '708 automatic tests in 49 files: all passed. Type check: no errors'],
    ['Scanned libraries', 'npm audit of the 3rd-party packages the server runs on'],
    ['Compared docs to code', 'README, work log, APP_CHANGES and DEPLOYMENT against what the code really does'],
    ['Checked for leaked secrets', 'Git history searched for the .env file: never committed'],
  ];
  steps.forEach(([h, b], i) => {
    const y = 1.4 + i * 1.02;
    s.addShape(pres.shapes.OVAL, { x: M, y: y + 0.08, w: 0.6, h: 0.6, fill: { color: HEX.accent1 }, line: { color: HEX.accent1 } });
    s.addText(String(i + 1), { x: M, y: y + 0.08, w: 0.6, h: 0.6, fontSize: 18, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', margin: 0, isTextBox: true });
    s.addText(h, { x: M + 0.85, y, w: 6.6, h: 0.4, fontSize: 18, bold: true, color: C.text2, margin: 0, isTextBox: true });
    s.addText(b, { x: M + 0.85, y: y + 0.4, w: 6.6, h: 0.45, fontSize: 14, color: C.text1, margin: 0, isTextBox: true });
  });
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 8.4, y: 1.4, w: 4.33, h: 4.95, rectRadius: 0.12, fill: { color: HEX.lt2 }, line: { color: HEX.lt2 }, objectName: 'tests panel' });
  s.addText('708 / 708', { x: 8.6, y: 2.0, w: 3.95, h: 1.1, fontSize: 50, bold: true, color: HEX.accent3, align: 'center', fontFace: THEME.headFontFace, margin: 0, isTextBox: true });
  s.addText('automatic tests passed', { x: 8.6, y: 3.1, w: 3.95, h: 0.45, fontSize: 18, bold: true, color: C.text1, align: 'center', margin: 0, isTextBox: true });
  s.addText('Each test is a small program that checks one rule, for example “a customer cannot pay for someone else’s order”. They run in about a minute.', { x: 8.75, y: 3.75, w: 3.65, h: 1.8, fontSize: 14, color: '5B6B73', align: 'left', margin: 0, isTextBox: true, valign: 'top' });
  s.addNotes('Limits of this audit: it is a code review, not a penetration test. The live Render server, Supabase project and Paystack account were not touched, and the newest database migrations were not run against a real database in this audit.');
}
{
  const s = slide();
  title(s, 'Scorecard');
  const y = image(s, '13-audit-scorecard', IMGBOX, 'Grades for nine areas: payments A, login A, tests A, structure A-, database B+, settings B, operations B, docs B, libraries C');
  caption(s, 'Overall: a well-built, carefully tested backend. The biggest risk is outdated libraries, not the team’s own code.', y + 0.1);
  s.addNotes('Green areas are genuinely strong and above what is typical for a young product. Amber areas are small, specific fixes. The one red area, third-party libraries, is common and fixable with an upgrade.');
}
{
  const s = slide();
  title(s, 'What is done well');
  const items = [
    ['Money is handled carefully', 'Prices come from the server. Paystack messages are signature-checked and re-confirmed. Payments flip to paid only once.', HEX.accent3],
    ['Safe to retry', '“Idempotency keys” mean a dropped connection can be retried without creating a second order or cash-out.', HEX.accent1],
    ['Strong login protection', 'Lockout after 5 wrong passwords, rate limits, revocable staff sessions, scrambled passwords and codes.', HEX.accent4],
    ['Nothing gets lost', 'Stock is reserved atomically and given back on failure or expiry. Migrations only ever add.', HEX.accent2],
    ['Every admin action recorded', 'The audit log stores who changed what, with passwords and codes blanked out.', HEX.accent6],
    ['Thoroughly tested and documented', '708 tests; detailed notes for the app teams and a deployment checklist.', HEX.accent5],
  ];
  items.forEach(([h, b, col], i) => card(s, M + (i % 3) * 4.1, 1.4 + Math.floor(i / 3) * 2.65, 3.85, 2.4, h, b, col, { bodySize: 14, headSize: 17 }));
  s.addNotes('These are the reasons the payments and login areas scored an A.');
}
{
  const s = slide();
  title(s, 'Findings, in plain English');
  const sev = { HIGH: HEX.accent5, MEDIUM: HEX.accent6, LOW: HEX.accent1 };
  const rows = [
    ['HIGH', 'Outdated libraries', '16 known weaknesses in borrowed code (2 critical, 7 high)', 'Run npm audit fix; plan a NestJS upgrade'],
    ['MEDIUM', 'Failed refunds only logged', 'If an automatic refund after a cancel fails, no admin is told', 'Add an admin list or alert for “cancelled but still paid”'],
    ['MEDIUM', 'Newest migrations untested', 'Food options, pre-orders and laundry vendors never ran on a real database', 'Run them on a copy of production first'],
    ['MEDIUM', 'Payment timeout setting ignored', 'ORDER_PAYMENT_TIMEOUT_MINUTES is documented but never read; always 30 min', 'One line in src/config/configuration.ts'],
    ['LOW', 'Unclear error for staff', 'A staff login placing an order gets a vague server error, not “not allowed”', 'Use the existing assertCustomer check'],
    ['LOW', 'Refund double-click', 'Two admins refunding at once could both ask Paystack', 'Mark the refund as started before calling Paystack'],
    ['LOW', 'Timers inside the server', 'Clean-up jobs pause if the server sleeps', 'Fine for one server; move to a scheduler later'],
    ['LOW', 'Out-of-date notes', 'README still says modules are “stubbed”; a leftover schema-additions file', 'Refresh README; delete the leftover file'],
  ];
  const hdr = ['Level', 'Finding', 'What it means', 'Fix'].map((t) => ({ text: t, options: { bold: true, color: 'FFFFFF', fill: { color: HEX.dk2 } } }));
  const data = [hdr, ...rows.map(([lv, f, m, fx], i) => {
    const fill = { color: i % 2 ? 'FFFFFF' : HEX.lt2 };
    return [
      { text: lv, options: { bold: true, color: sev[lv], fill } },
      { text: f, options: { bold: true, fill } },
      { text: m, options: { fill } },
      { text: fx, options: { fill } },
    ];
  })];
  s.addTable(data, { x: M, y: 1.3, w: W - 2 * M, colW: [1.05, 2.6, 4.6, 3.88], fontSize: 12.5, color: HEX.dk1, border: { type: 'none' }, margin: [3, 6, 3, 6], valign: 'middle', rowH: 0.6, objectName: 'findings table' });
  s.addNotes('Details for the developer:\n1. npm audit (production deps): critical proxy-addr and tar; high multer, body-parser, @nestjs/platform-express, @nestjs/config, lodash, brace-expansion, @mapbox/node-pre-gyp.\n2. OrdersService.cancelByCustomer returns refund PENDING_ADMIN and logs a warning; nothing in the admin API lists these orders.\n3. BACKEND_WORK_LOG.md says migrations 20261111000000, 20261111030000 and 20261111060000 were not run on a real Postgres.\n4. orders.service.ts reads orders.paymentTimeoutMinutes, which configuration.ts never defines.\n5. POST /orders, /laundry/orders, /payments/initialize, /preorders do not call assertCustomer; the foreign key to users then fails with a 500.\n6. PaymentsService.refund calls the provider before the conditional status update.\n7. setInterval sweeps in OrdersService and PresenceService.\n8. README "What\'s real vs. stubbed"; prisma/schema-additions.prisma.');
}
{
  const s = slide();
  title(s, 'The library risk in detail');
  s.addChart(pres.charts.BAR, [{ name: 'Known weaknesses', labels: ['Critical', 'High', 'Moderate'], values: [2, 7, 7] }], {
    x: M, y: 1.4, w: 6.2, h: 4.9, barDir: 'bar', chartColors: [HEX.accent5, HEX.accent2, HEX.accent6],
    showTitle: true, title: 'Known weaknesses by severity (npm audit, 13 Nov 2026)', titleFontSize: 14, titleColor: HEX.dk1, titleFontFace: '+mn-lt',
    showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 14, dataLabelColor: HEX.dk1, dataLabelFontFace: '+mn-lt',
    catAxisLabelColor: '5B6B73', valAxisLabelColor: '5B6B73', catAxisLabelFontSize: 14, valAxisLabelFontSize: 12, catAxisLabelFontFace: '+mn-lt', valAxisLabelFontFace: '+mn-lt',
    valGridLine: { color: 'DCE6E9', size: 0.75 }, catGridLine: { style: 'none' }, showLegend: false, valAxisMaxVal: 8, valAxisMajorUnit: 2,
    objectName: 'vulnerability chart',
  });
  card(s, 7.15, 1.4, 5.58, 2.3, 'Quick win (no code changes)', 'npm audit fix updates proxy-addr, tar, qs, nodemailer, brace-expansion and others within their current versions. Run the tests afterwards.', HEX.accent3, { bodySize: 14 });
  card(s, 7.15, 4.0, 5.58, 2.3, 'Bigger job (plan it)', 'The rest sit inside the NestJS framework itself (v10). They go away with a major framework upgrade, which needs a day or two of testing.', HEX.accent5, { bodySize: 14 });
  s.addNotes('Borrowed code (libraries) is like ingredients from a supplier: when the supplier announces a recall, you swap the ingredient. Most of these weaknesses need unusual conditions to exploit, but critical and high ones should not be left for long.');
}
{
  const s = slide();
  title(s, 'Built, but waiting on a business decision');
  const items = [
    ['Paying for pre-orders', 'Deposit or full payment for an accepted quote, and how it becomes a delivery', HEX.accent2],
    ['Laundry vendor payouts', 'Only the commission rate is stored; no payouts to laundries yet', HEX.accent4],
    ['Delivery window rules', 'Windows run every day with no limit per slot, and food has none', HEX.accent1],
    ['Partner verification switch', 'Turn on compulsory document checks once current partners have uploaded', HEX.accent3],
    ['Not started', 'Customer wallet, loyalty points, Nsano gateway, SMS: not yet defined', HEX.accent6],
  ];
  items.forEach(([h, b, col], i) => {
    const y = 1.4 + i * 1.02;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y, w: W - 2 * M, h: 0.88, rectRadius: 0.1, fill: { color: HEX.lt2 }, line: { color: HEX.lt2 }, objectName: 'decision ' + h });
    s.addShape(pres.shapes.OVAL, { x: M + 0.22, y: y + 0.24, w: 0.4, h: 0.4, fill: { color: col }, line: { color: col } });
    s.addText(h, { x: M + 0.85, y, w: 3.6, h: 0.88, fontSize: 17, bold: true, color: col, valign: 'middle', margin: 0, isTextBox: true });
    s.addText(b, { x: M + 4.5, y, w: 7.4, h: 0.88, fontSize: 15, color: C.text1, valign: 'middle', margin: 0, isTextBox: true });
  });
  s.addNotes('These are not bugs. They are gaps the work log marks as waiting for a decision from the business side. Listing them avoids surprises.');
}
{
  const s = slide();
  title(s, 'Recommended next steps');
  const steps = [
    ['This week', 'Run npm audit fix and the tests. Fix the payment-timeout setting (one line). Refresh the README.', HEX.accent5],
    ['Before the next release', 'Apply the three newest migrations to a copy of production and run the smoke tests in DEPLOYMENT.md.', HEX.accent2],
    ['Next sprint', 'Give admins a list of cancelled-but-paid orders. Add the customer-only check to order and payment routes. Lock refunds before calling Paystack.', HEX.accent6],
    ['This quarter', 'Upgrade NestJS to the current major version. Decide on pre-order payment and laundry payouts.', HEX.accent1],
  ];
  steps.forEach(([h, b, col], i) => {
    const x = M + i * 3.07;
    card(s, x, 1.45, 2.85, 3.3, h, b, col, { num: i + 1, bodySize: 15, headSize: 17 });
  });
  s.addText('None of the findings is an emergency. All are ordinary maintenance for a fast-growing product.', { x: M, y: 5.05, w: W - 2 * M, h: 0.5, fontSize: 16, italic: true, color: C.text2, margin: 0, isTextBox: true });
  s.addNotes('A developer can finish the “this week” items in under an hour. The NestJS upgrade is the only item that needs real planning.');
}

// ════════════════════════════════════════════════════════════════════
sec('Reference');
{
  const s = slide();
  title(s, 'Glossary');
  const terms = [
    ['Backend', 'The program on a server that the apps talk to. The “kitchen”.'],
    ['API route', 'One specific request the apps may make, like “place an order”.'],
    ['Database / table', 'Where information is stored, organised like spreadsheet tabs.'],
    ['Migration', 'A dated script that changes the database structure safely.'],
    ['Module', 'A department of the code that owns one business area.'],
    ['JWT / token', 'A signed digital pass the app shows to prove who is asking.'],
    ['Session', 'A staff login that can be ended instantly by the backend.'],
    ['Webhook', 'A message Paystack sends to the backend when something happens.'],
    ['Idempotency key', 'A label that lets a request be safely retried without doubling it.'],
    ['Event bus', 'The internal announcement board departments use to share news.'],
    ['Rate limit', 'A cap on how many requests can be made per minute.'],
    ['npm audit', 'A scan of borrowed code for publicly known weaknesses.'],
  ];
  const mk = (ts) => ts.map(([a, b], i) => [
    { text: a, options: { bold: true, color: HEX.dk2, fill: { color: i % 2 ? 'FFFFFF' : HEX.lt2 } } },
    { text: b, options: { fill: { color: i % 2 ? 'FFFFFF' : HEX.lt2 } } },
  ]);
  const topt = { fontSize: 14, color: HEX.dk1, border: { type: 'none' }, margin: [4, 8, 4, 8], valign: 'middle', rowH: 0.78 };
  s.addTable(mk(terms.slice(0, 6)), { x: M, y: 1.35, w: 5.95, colW: [1.9, 4.05], ...topt, objectName: 'glossary 1' });
  s.addTable(mk(terms.slice(6)), { x: 6.78, y: 1.35, w: 5.95, colW: [1.9, 4.05], ...topt, objectName: 'glossary 2' });
}
{
  const s = slide('TITLE_DARK');
  s.addText('In one sentence', { placeholder: 'title' });
  s.addText('A well-organised, carefully tested backend that handles money and logins safely; keep its libraries up to date and close the few small gaps listed in the audit.', { placeholder: 'body' });
  s.addText('All pictures are in presentation/images (PNG and SVG). Details for developers are in the speaker notes.', { x: M, y: 6.6, w: 12, h: 0.4, fontSize: 13, color: HEX.lt2, margin: 0, isTextBox: true });
}

(async () => {
  await pres.writeFile({ fileName: FILE });
  await applyTheme(FILE, THEME);
  console.log('wrote', FILE);
})().catch((e) => { console.error(e); process.exit(1); });
