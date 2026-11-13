// Builds the explanatory pictures for the backend presentation.
// Output: <out>/images/NN-name.svg and .png
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = process.argv[2];
const IMG = path.join(OUT, 'images');
fs.mkdirSync(IMG, { recursive: true });

const K = {
  teal: '0B4F5C', tealMid: '1F7A8C', tealLight: 'DCEFF2', tealPale: 'F0F8F9',
  orange: 'E07B2A', orangeLight: 'FDEBDC',
  red: 'B83227', redLight: 'F9E0DD',
  amber: 'B7791F', amberLight: 'FCF1D6',
  green: '2E7D4F', greenLight: 'DFF2E6',
  purple: '5B4B9A', purpleLight: 'E9E5F6',
  ink: '1D2B33', grey: '5B6B73', line: '9FB3BA', white: 'FFFFFF',
};
const c = (k) => '#' + (K[k] || k);
const FONT = "Segoe UI, Arial, sans-serif";
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrap(text, max) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) { if (cur) lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function txt(x, y, s, o = {}) {
  const size = o.size || 22, lh = o.lh || size * 1.25;
  const lines = Array.isArray(s) ? s : (o.wrap ? wrap(s, o.wrap) : [s]);
  const anchor = o.anchor || 'middle';
  const y0 = o.valign === 'middle' ? y - ((lines.length - 1) * lh) / 2 : y;
  return lines.map((l, i) =>
    `<text x="${x}" y="${y0 + i * lh}" font-family="${FONT}" font-size="${size}" font-weight="${o.bold ? 700 : 400}" fill="${c(o.color || 'ink')}" text-anchor="${anchor}" dominant-baseline="middle"${o.halo ? ' stroke="#FFFFFF" stroke-width="10" paint-order="stroke" stroke-linejoin="round"' : ''}${o.italic ? ' font-style="italic"' : ''}>${esc(l)}</text>`).join('');
}

function box(x, y, w, h, o = {}) {
  const r = o.r ?? 18;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${c(o.fill || 'white')}" stroke="${c(o.stroke || 'line')}" stroke-width="${o.sw ?? 2}"${o.dash ? ' stroke-dasharray="8 6"' : ''}/>`;
  const cx = x + w / 2;
  if (o.title && o.sub) {
    const tl = Array.isArray(o.title) ? o.title : wrap(o.title, o.twrap || 40);
    const sl = Array.isArray(o.sub) ? o.sub : wrap(o.sub, o.wrap || Math.floor(w / ((o.subSize || 18) * 0.52)));
    const ts = o.titleSize || 24, ss = o.subSize || 18;
    const total = tl.length * ts * 1.2 + 8 + sl.length * ss * 1.3;
    let yy = y + h / 2 - total / 2 + ts * 0.6;
    s += txt(cx, yy, tl, { size: ts, bold: true, color: o.titleColor || 'ink', lh: ts * 1.2 });
    yy += tl.length * ts * 1.2 - ts * 0.6 + 8 + ss * 0.65;
    s += txt(cx, yy, sl, { size: ss, color: o.subColor || 'grey', lh: ss * 1.3 });
  } else if (o.title) {
    const tl = Array.isArray(o.title) ? o.title : wrap(o.title, o.twrap || Math.floor(w / ((o.titleSize || 22) * 0.55)));
    s += txt(cx, y + h / 2, tl, { size: o.titleSize || 22, bold: o.bold !== false, color: o.titleColor || 'ink', valign: 'middle' });
  }
  return s;
}

function badge(x, y, n, o = {}) {
  const r = o.r || 22;
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${c(o.fill || 'orange')}"/>` + txt(x, y + 1, String(n), { size: o.size || 22, bold: true, color: 'white' });
}

function arrow(x1, y1, x2, y2, o = {}) {
  const col = c(o.color || 'grey');
  const id = 'a' + Math.random().toString(36).slice(2, 8);
  let s = `<defs><marker id="${id}" markerUnits="userSpaceOnUse" markerWidth="18" markerHeight="18" refX="15" refY="9" orient="auto"><path d="M0,0 L18,9 L0,18 z" fill="${col}"/></marker></defs>`;
  const d = o.path || `M${x1},${y1} L${x2},${y2}`;
  s += `<path d="${d}" stroke="${col}" stroke-width="${o.sw || 3}" fill="none" marker-end="url(#${id})"${o.dash ? ' stroke-dasharray="8 6"' : ''}/>`;
  if (o.label) {
    const lx = o.lx ?? (x1 + x2) / 2, ly = o.ly ?? (y1 + y2) / 2 - 16;
    s += txt(lx, ly, o.label, { size: o.lsize || 17, color: o.lcolor || 'grey', italic: o.italic, wrap: o.lwrap });
  }
  return s;
}

const svgDoc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#FFFFFF"/>${body}</svg>`;

const jobs = [];
function save(name, w, h, body) {
  const svg = svgDoc(w, h, body);
  fs.writeFileSync(path.join(IMG, name + '.svg'), svg);
  jobs.push(sharp(Buffer.from(svg), { density: 144 }).png().toFile(path.join(IMG, name + '.png')));
}

// ── 01 The restaurant analogy ─────────────────────────────────────────
{
  const W = 1600, H = 760; let b = '';
  b += box(40, 110, 400, 520, { fill: 'tealPale', stroke: 'tealMid' });
  b += txt(240, 155, 'THE DINING ROOM', { size: 26, bold: true, color: 'tealMid' });
  b += txt(240, 192, '= the apps people hold', { size: 20, color: 'grey', italic: true });
  b += box(80, 235, 320, 100, { fill: 'white', stroke: 'tealMid', title: 'Customer app', sub: 'shop, order food, laundry' });
  b += box(80, 360, 320, 100, { fill: 'white', stroke: 'tealMid', title: 'Delivery app', sub: 'riders & walkers take jobs' });
  b += box(80, 485, 320, 100, { fill: 'white', stroke: 'tealMid', title: 'Admin console', sub: 'the managers’ control room' });

  b += box(580, 60, 440, 620, { fill: 'teal', stroke: 'teal' });
  b += txt(800, 115, 'THE KITCHEN', { size: 30, bold: true, color: 'white' });
  b += txt(800, 155, '= this backend', { size: 21, color: 'tealLight', italic: true });
  const k = ['Takes every order ticket', 'Checks who is asking', 'Applies the house rules', 'Works out prices itself', 'Tells everyone what changed'];
  k.forEach((t, i) => {
    b += `<rect x="620" y="${200 + i * 88}" width="360" height="70" rx="14" fill="#13606E"/>`;
    b += badge(660, 235 + i * 88, i + 1, { r: 20, size: 20 });
    b += txt(700, 235 + i * 88, t, { size: 21, color: 'white', anchor: 'start' });
  });

  b += box(1160, 110, 400, 250, { fill: 'orangeLight', stroke: 'orange' });
  b += txt(1360, 160, 'THE PANTRY', { size: 26, bold: true, color: 'orange' });
  b += txt(1360, 198, '= the database', { size: 20, color: 'grey', italic: true });
  b += txt(1360, 265, ['Every customer, product, order,', 'payment and delivery is stored', 'here (Supabase Postgres)'], { size: 19, color: 'ink', valign: 'middle' });

  b += box(1160, 400, 400, 230, { fill: 'purpleLight', stroke: 'purple' });
  b += txt(1360, 445, 'OUTSIDE HELPERS', { size: 24, bold: true, color: 'purple' });
  b += txt(1360, 530, ['Paystack – the cashier', 'Email & phone push – the messengers', 'File storage – the photo cabinet', 'Google – the ID checker'], { size: 19, color: 'ink', valign: 'middle' });

  b += arrow(445, 330, 572, 330, { color: 'tealMid', label: 'orders in', lsize: 18 });
  b += arrow(575, 420, 448, 420, { color: 'tealMid', label: 'answers out', lsize: 18, ly: 450, lx: 520 });
  b += arrow(1025, 235, 1152, 235, { color: 'orange' });
  b += arrow(1025, 515, 1152, 515, { color: 'purple' });
  b += txt(800, 728, 'Nobody in the dining room ever walks into the pantry. Everything goes through the kitchen.', { size: 22, color: 'grey', italic: true });
  save('01-restaurant-analogy', W, H, b);
}

// ── 02 Who uses it ───────────────────────────────────────────────────
{
  const W = 1600, H = 700; let b = '';
  const people = [
    ['Customer', 'tealMid', 'tealPale', 'Customer app', ['Shops the marketplace', 'Orders food with add-ons', 'Books laundry pickups', 'Pays by MoMo or card', 'Requests custom pre-orders', 'Raises support tickets']],
    ['Delivery partner', 'orange', 'orangeLight', 'Delivery app', ['Applies to join', 'Claims delivery jobs', 'Moves a job step by step', 'Checks the 6-digit code', 'Earns per delivery', 'Cashes out the wallet']],
    ['Vendor', 'green', 'greenLight', 'Admin / partner tools', ['Owns a food stall', 'Edits its own menu', 'Adds options and extras', '(e.g. "extra egg +GH₵2")']],
    ['Laundry staff', 'purple', 'purpleLight', 'Staff tools', ['Belongs to one laundry', 'Sees only its orders', 'Moves clothes through', '13 cleaning stages']],
    ['Admin', 'red', 'redLight', 'Admin console', ['Sees everything', 'Approves partners', 'Sets fees and settings', 'Refunds payments', 'Sends announcements', 'Every change is logged']],
  ];
  const w = 290, gap = 22, x0 = (W - (5 * w + 4 * gap)) / 2;
  people.forEach(([name, col, light, app, list], i) => {
    const x = x0 + i * (w + gap);
    b += box(x, 40, w, 620, { fill: light, stroke: col });
    b += `<circle cx="${x + w / 2}" cy="120" r="46" fill="${c(col)}"/>`;
    b += `<circle cx="${x + w / 2}" cy="106" r="16" fill="#fff"/><path d="M${x + w / 2 - 28},146 a28,24 0 0 1 56,0 z" fill="#fff"/>`;
    b += txt(x + w / 2, 200, name, { size: 25, bold: true, color: col });
    b += txt(x + w / 2, 235, 'uses the ' + app, { size: 17, color: 'grey', italic: true });
    list.forEach((t, j) => {
      b += `<circle cx="${x + 28}" cy="${292 + j * 58}" r="6" fill="${c(col)}"/>`;
      b += txt(x + 44, 292 + j * 58, t, { size: 18.5, anchor: 'start' });
    });
  });
  save('02-who-uses-it', W, H, b);
}

// ── 03 Architecture map ──────────────────────────────────────────────
{
  const W = 1600, H = 820; let b = '';
  b += txt(150, 40, 'APPS', { size: 20, bold: true, color: 'grey' });
  ['Customer app', 'Delivery app', 'Admin console'].forEach((t, i) => {
    b += box(30, 80 + i * 140, 240, 100, { fill: 'tealPale', stroke: 'tealMid', title: t });
    b += arrow(272, 130 + i * 140, 340, 330 + (i - 1) * 60, { color: 'tealMid' });
  });
  b += txt(150, 560, ['They talk to the', 'backend over the', 'internet (HTTPS)', 'at /api/v1/...'], { size: 17, color: 'grey', italic: true });

  b += box(345, 80, 150, 580, { fill: 'redLight', stroke: 'red' });
  b += txt(420, 300, ['FRONT', 'DOOR'], { size: 22, bold: true, color: 'red', lh: 28 });
  b += txt(420, 400, ['ID check', 'speed limit', 'role check', 'form check'], { size: 16, color: 'ink', lh: 26 });
  b += arrow(497, 370, 545, 370, { color: 'red' });

  b += box(550, 30, 700, 760, { fill: 'tealPale', stroke: 'teal', sw: 3 });
  b += txt(900, 66, 'THE BACKEND – 18 DEPARTMENTS (MODULES)', { size: 22, bold: true, color: 'teal' });
  const groups = [
    ['Accounts', 'tealMid', ['identity', 'staff', 'partner-applications', 'addresses']],
    ['Shopping', 'green', ['marketplace', 'food', 'orders', 'preorders']],
    ['Services', 'purple', ['laundry', 'logistics (delivery)']],
    ['Money', 'orange', ['payments', 'wallet & payouts*']],
    ['Talking', 'amber', ['notifications', 'support', 'promotions', 'faq']],
    ['Running it', 'red', ['admin', 'settings', 'app-config']],
  ];
  groups.forEach(([g, col, mods], i) => {
    const gx = 575 + (i % 2) * 340, gy = 95 + Math.floor(i / 2) * 225, gw = 320, gh = 205;
    b += box(gx, gy, gw, gh, { fill: 'white', stroke: col, r: 14 });
    b += txt(gx + gw / 2, gy + 28, g.toUpperCase(), { size: 19, bold: true, color: col });
    mods.forEach((m, j) => {
      const mx = gx + 16 + (j % 2) * 148, my = gy + 55 + Math.floor(j / 2) * 70;
      b += `<rect x="${mx}" y="${my}" width="140" height="56" rx="10" fill="${c(col)}" opacity="0.12"/>`;
      b += txt(mx + 70, my + 28, wrap(m, 14), { size: 15.5, bold: true, color: 'ink', valign: 'middle', lh: 18 });
    });
  });
  b += txt(900, 772, '* part of logistics.   All departments share one “event bus” to tell each other news.', { size: 15, color: 'grey', italic: true });

  const ext = [
    ['Database', 'Supabase Postgres – 42 tables', 'orange', 'orangeLight'],
    ['File storage', 'Supabase – photos & documents', 'orange', 'orangeLight'],
    ['Paystack', 'Mobile Money & card payments', 'purple', 'purpleLight'],
    ['Email (SMTP)', 'codes & approval emails', 'purple', 'purpleLight'],
    ['Expo push', 'phone notifications', 'purple', 'purpleLight'],
    ['Google', 'sign in with Google', 'purple', 'purpleLight'],
  ];
  ext.forEach(([t, s, col, light], i) => {
    const y = 40 + i * 125;
    b += box(1320, y, 260, 105, { fill: light, stroke: col, title: t, sub: s, titleSize: 21, subSize: 16 });
    b += arrow(1252, y + 52, 1314, y + 52, { color: col, sw: 2.5 });
  });
  save('03-architecture-map', W, H, b);
}

// ── 04 Journey of one request ────────────────────────────────────────
{
  const W = 1600, H = 780; let b = '';
  const steps = [
    ['Name tag', 'Every request gets a tracking number (X-Request-Id)', 'tealMid'],
    ['Safety headers', 'Standard browser protections are added', 'tealMid'],
    ['Speed limit', 'Too many tries in a minute? Told to slow down', 'red'],
    ['Who are you?', 'The login token (JWT) is checked', 'red'],
    ['Allowed?', 'Your role must match (e.g. ADMIN only)', 'red'],
    ['Form check', 'Bad or unknown fields are rejected', 'amber'],
    ['Do the work', 'The department applies its rules', 'green'],
    ['Pantry', 'Data is read or saved in the database', 'orange'],
    ['Reply', 'Same tidy answer shape every time', 'tealMid'],
    ['Logbook', 'Admin changes are written to the audit log', 'purple'],
  ];
  const bw = 270, bh = 210, gx = 40, top = [70, 430];
  steps.forEach(([t, s, col], i) => {
    const row = i < 5 ? 0 : 1;
    const idx = row === 0 ? i : 9 - i; // snake back on row 2
    const x = 40 + idx * (bw + 40), y = top[row];
    b += box(x, y, bw, bh, { fill: 'white', stroke: col, sw: 2.5, title: t, sub: s, titleSize: 23, subSize: 17.5 });
    b += badge(x + 28, y + 28, i + 1, { fill: col, r: 19, size: 19 });
    if (i < 4) b += arrow(x + bw + 3, y + bh / 2, x + bw + 36, y + bh / 2, { color: 'grey' });
    if (i >= 5 && i < 9) b += arrow(x - 3, y + bh / 2, x - 36, y + bh / 2, { color: 'grey' });
  });
  // row turn
  const lastX = 40 + 4 * (bw + 40) + bw / 2;
  b += arrow(lastX, top[0] + bh + 3, lastX, top[1] - 6, { color: 'grey' });
  b += txt(800, 345, 'If any red step says no, the request stops right there and gets a clear error – nothing is saved.', { size: 21, color: 'red', italic: true });
  b += txt(800, 735, 'This happens for every single tap in every app, usually in a fraction of a second.', { size: 20, color: 'grey', italic: true });
  save('04-request-journey', W, H, b);
}

// ── 05 Order lifecycle ───────────────────────────────────────────────
{
  const W = 1600, H = 800; let b = '';
  const main = [
    ['Basket', 'Customer picks products or food', 'tealMid'],
    ['Place order', 'Backend sets prices & fee, holds the stock', 'tealMid'],
    ['Pay', 'MoMo or card through Paystack', 'orange'],
    ['Confirmed', 'Payment proven; delivery job opens', 'green'],
    ['Preparing', 'Shop or kitchen gets it ready', 'green'],
    ['On the way', 'A partner carries it', 'purple'],
    ['Delivered', 'Customer gives the 6-digit code', 'green'],
  ];
  const bw = 196, gap = 28, y = 180, bh = 175;
  main.forEach(([t, s, col], i) => {
    const x = 30 + i * (bw + gap);
    b += box(x, y, bw, bh, { fill: 'white', stroke: col, sw: 3, title: t, sub: s, titleSize: 22, subSize: 16.5 });
    b += badge(x + bw / 2, y - 2, i + 1, { fill: col, r: 20, size: 19 });
    if (i < main.length - 1) b += arrow(x + bw + 2, y + bh / 2, x + bw + gap - 2, y + bh / 2, { color: 'grey' });
  });
  b += txt(800, 70, 'A MARKETPLACE OR FOOD ORDER, FROM BASKET TO DOORSTEP', { size: 24, bold: true, color: 'teal' });
  b += txt(800, 110, 'Prices, delivery fee and totals are always worked out by the backend, never trusted from the phone.', { size: 19, color: 'grey', italic: true });

  // side paths
  const payX = 30 + 2 * (bw + gap) + bw / 2, confX = 30 + 3 * (bw + gap) + bw / 2;
  b += arrow(payX, y + bh + 3, 300, 468, { color: 'red', dash: true });
  b += box(40, 475, 490, 150, { fill: 'redLight', stroke: 'red', title: 'Never paid?', sub: 'After 30 minutes (24 h if payment was started) the order is cancelled automatically and the stock goes back on the shelf.', titleSize: 21, subSize: 16.5 });
  b += arrow(confX, y + bh + 3, confX, 468, { color: 'amber', dash: true });
  b += box(555, 475, 490, 150, { fill: 'amberLight', stroke: 'amber', title: 'Customer cancels?', sub: 'Allowed before preparing starts. Stock returns and a paid order is refunded automatically (or left for an admin).', titleSize: 21, subSize: 16.5 });
  b += box(1070, 475, 490, 150, { fill: 'tealPale', stroke: 'tealMid', title: 'Good to know: delivery windows', sub: 'Marketplace orders get a slot: before 9:00 → same morning, 9:00–14:59 → afternoon, later → next morning. Can be moved twice.', titleSize: 21, subSize: 16 });
  b += txt(800, 680, 'Retrying a slow request is safe: an “idempotency key” stops the same order being created twice.', { size: 19, color: 'grey', italic: true });
  b += txt(800, 720, 'Every step sends the customer a notification (in-app list + phone push).', { size: 19, color: 'grey', italic: true });
  save('05-order-lifecycle', W, H, b);
}

// ── 06 Payment flow (sequence) ───────────────────────────────────────
{
  const W = 1600, H = 820; let b = '';
  const lanes = [['Customer app', 'tealMid', 'tealPale', 230], ['Backend', 'teal', 'tealLight', 800], ['Paystack', 'purple', 'purpleLight', 1370]];
  lanes.forEach(([t, col, light, x]) => {
    b += box(x - 160, 20, 320, 80, { fill: light, stroke: col, title: t, titleSize: 25 });
    b += `<line x1="${x}" y1="100" x2="${x}" y2="800" stroke="${c(col)}" stroke-width="3" stroke-dasharray="6 8"/>`;
  });
  const L = { a: 230, b: 800, p: 1370 };
  const msgs = [
    ['a', 'b', '1. "I want to pay for order #123 with MoMo"'],
    ['b', 'b', '2. Looks up the amount from the saved order (the phone cannot change it)'],
    ['b', 'p', '3. "Start a payment of GH₵ X, reference FM-…"'],
    ['p', 'a', '4. Customer approves on Paystack’s secure page / phone prompt'],
    ['p', 'b', '5. Webhook: "payment done" – signed with a secret'],
    ['b', 'b', '6. Signature checked, then asks Paystack again to confirm'],
    ['b', 'b', '7. Amount and currency must match exactly, else refused'],
    ['b', 'a', '8. Marked PAID once; delivery job created; customer notified'],
  ];
  msgs.forEach(([f, t, label], i) => {
    const y = 160 + i * 82;
    if (f === t) {
      b += `<rect x="${L.b - 10}" y="${y - 22}" width="20" height="44" fill="${c('teal')}"/>`;
      b += txt(L.b + 30, y, label, { size: 19, anchor: 'start', color: 'ink', wrap: 60 });
    } else {
      const x1 = L[f], x2 = L[t];
      const dir = x2 > x1 ? 1 : -1;
      b += arrow(x1 + dir * 12, y, x2 - dir * 14, y, { color: f === 'p' ? 'purple' : 'teal', sw: 3 });
      b += txt((x1 + x2) / 2, y - 22, label, { size: 19, color: 'ink', halo: true });
    }
  });
  save('06-payment-flow', W, H, b);
}

// ── 07 Delivery job flow ─────────────────────────────────────────────
{
  const W = 1600, H = 800; let b = '';
  b += txt(800, 40, 'A DELIVERY JOB, AS THE PARTNER SEES IT', { size: 24, bold: true, color: 'teal' });
  const st = [
    ['Waiting', 'New job is announced to partners', 'grey'],
    ['Claimed', 'First partner to claim gets it (no double-booking)', 'orange'],
    [['Heading to', 'the shop'], 'on the way to collect', 'purple'],
    ['Paying vendor', 'optional: pays the shop', 'purple'],
    ['Picked up', 'Parcel collected', 'purple'],
    [['Heading to', 'the customer'], 'on the way to drop off', 'purple'],
    ['Delivered', 'Only with the customer’s 6-digit code', 'green'],
  ];
  const bw = 196, gap = 28, y = 100, bh = 165;
  st.forEach(([t, s, col], i) => {
    const x = 30 + i * (bw + gap);
    b += box(x, y, bw, bh, { fill: 'white', stroke: col, sw: 3, title: t, sub: s, titleSize: 21, subSize: 16 });
    if (i < st.length - 1) b += arrow(x + bw + 2, y + bh / 2, x + bw + gap - 2, y + bh / 2, { color: 'grey' });
  });
  b += txt(800, 300, 'Steps can only go forward, one at a time. Skipping or going backwards is refused.', { size: 19, color: 'grey', italic: true });

  b += box(30, 345, 740, 205, { fill: 'tealPale', stroke: 'tealMid' });
  b += txt(400, 380, 'THE HANDOVER CODE', { size: 22, bold: true, color: 'tealMid' });
  b += txt(400, 470, ['A 6-digit code is made when the order is placed.', 'Only the customer can see it in their app.', 'It is stored scrambled (hashed + encrypted).', 'Too many wrong guesses locks it for a while.'], { size: 18.5, lh: 28, valign: 'middle' });

  b += box(830, 345, 740, 205, { fill: 'orangeLight', stroke: 'orange' });
  b += txt(1200, 380, 'WHO GETS THE JOB', { size: 22, bold: true, color: 'orange' });
  b += txt(1200, 470, ['Up to 2 km: a walking partner can take it.', 'Further: a motorcycle partner.', 'Partners must be online (and verified, if turned on).', 'Food partners carry at most 3 jobs at once.'], { size: 18.5, lh: 28, valign: 'middle' });

  // money strip
  const m = [['Delivered', 'green'], ['Earning added to wallet', 'green'], ['Partner asks to cash out', 'orange'], ['Admin pays & marks PAID', 'red']];
  m.forEach(([t, col], i) => {
    const x = 70 + i * 380;
    b += box(x, 610, 320, 90, { fill: 'white', stroke: col, sw: 2.5, title: t, titleSize: 20 });
    if (i < 3) b += arrow(x + 322, 655, x + 376, 655, { color: 'grey' });
  });
  b += txt(800, 750, 'THE MONEY SIDE: partners are paid a fixed amount per delivery (set by admins)', { size: 19, color: 'grey', italic: true });
  save('07-delivery-flow', W, H, b);
}

// ── 08 Laundry flow ──────────────────────────────────────────────────
{
  const W = 1600, H = 720; let b = '';
  b += txt(800, 40, 'A LAUNDRY ORDER GOES THROUGH 13 STAGES', { size: 24, bold: true, color: 'purple' });
  const st = ['Pickup requested', 'Received', 'Inspected', 'Tagged', 'Washing', 'Drying', 'Ironing', 'Folding', 'Quality check', 'Packaged', 'Ready for delivery', 'Out for delivery', 'Completed'];
  const per = 7, bw = 190, gap = 30, bh = 90;
  st.forEach((t, i) => {
    const row = i < per ? 0 : 1;
    const idx = row === 0 ? i : i - per;
    const x = 40 + idx * (bw + gap) + (row ? (bw + gap) / 2 : 0), y = row ? 330 : 120;
    const col = i === 0 ? 'tealMid' : i === st.length - 1 ? 'green' : i >= 10 ? 'orange' : 'purple';
    b += box(x, y, bw, bh, { fill: 'white', stroke: col, sw: 2.5, title: t, titleSize: 19 });
    b += badge(x + 18, y + 4, i + 1, { fill: col, r: 16, size: 15 });
    if (i < st.length - 1 && i !== per - 1) b += arrow(x + bw + 2, y + bh / 2, x + bw + gap - 2, y + bh / 2, { color: 'grey' });
  });
  const lx = 40 + 6 * (bw + gap) + bw / 2;
  b += arrow(lx, 213, lx - 80, 325, { color: 'grey', path: `M${lx},213 C${lx},280 ${130 + bw / 2},260 ${150 + bw / 2},325` });
  b += box(40, 490, 490, 190, { fill: 'purpleLight', stroke: 'purple', title: 'Many laundries, one app', sub: 'Customers choose an approved, open laundry (best rated first) and order from its price list. They can rate it after a completed order.', titleSize: 21, subSize: 17 });
  b += box(555, 490, 490, 190, { fill: 'tealPale', stroke: 'tealMid', title: 'Staff only see their own', sub: 'Laundry staff are tied to one laundry. They can only view and move orders belonging to it.', titleSize: 21, subSize: 17 });
  b += box(1070, 490, 490, 190, { fill: 'orangeLight', stroke: 'orange', title: 'Customer kept informed', sub: 'Each stage change sends a notification. Pickup and return trips run through the same delivery system.', titleSize: 21, subSize: 17 });
  save('08-laundry-flow', W, H, b);
}

// ── 09 Partner onboarding ────────────────────────────────────────────
{
  const W = 1600, H = 640; let b = '';
  const st = [
    ['Apply', 'Fills in name, phone, ID details and walking/motorcycle in the Delivery app', 'tealMid'],
    ['Admin reviews', 'Approves or rejects with a reason', 'red'],
    ['Account made', 'A delivery-partner login is created automatically', 'green'],
    ['Email with code', 'A one-time setup code, valid for a few days', 'orange'],
    ['Sets password', 'Partner chooses their own password with the code', 'purple'],
    [['Uploads', 'documents'], 'ID, licence, photo – checked by admin', 'purple'],
    ['Goes online', 'Starts claiming jobs', 'green'],
  ];
  const bw = 196, gap = 28, y = 130, bh = 240;
  b += txt(800, 50, 'HOW A NEW DELIVERY PARTNER JOINS', { size: 24, bold: true, color: 'teal' });
  st.forEach(([t, s, col], i) => {
    const x = 30 + i * (bw + gap);
    b += box(x, y, bw, bh, { fill: 'white', stroke: col, sw: 3, title: t, sub: s, titleSize: 21, subSize: 16.5 });
    b += badge(x + bw / 2, y - 2, i + 1, { fill: col, r: 20, size: 19 });
    if (i < st.length - 1) b += arrow(x + bw + 2, y + bh / 2, x + bw + gap - 2, y + bh / 2, { color: 'grey' });
  });
  b += box(30, 430, 760, 170, { fill: 'tealPale', stroke: 'tealMid', title: ['Why a code instead of a password in the email?'], sub: 'Nobody, not even the admin, ever knows the partner’s password. If the email fails, the partner can ask for a new code or an admin can set one.', titleSize: 20, subSize: 17 });
  b += box(810, 430, 760, 170, { fill: 'redLight', stroke: 'red', title: ['Staff accounts can be switched off instantly'], sub: 'Each staff login is a “session” checked on every request. Logging out, a password reset or deactivation ends it immediately.', titleSize: 20, subSize: 17 });
  save('09-partner-onboarding', W, H, b);
}

// ── 10 Events ────────────────────────────────────────────────────────
{
  const W = 1600, H = 760; let b = '';
  b += `<rect x="40" y="330" width="1520" height="90" rx="45" fill="${c('teal')}"/>`;
  b += txt(800, 375, 'EVENT BUS – the kitchen’s announcement board', { size: 26, bold: true, color: 'white' });
  const pubs = [['Orders', '“order created”, “status changed”'], ['Payments', '“payment successful”, “refunded”'], ['Delivery', '“job created”, “status changed”'], ['Laundry', '“laundry created”, “stage changed”'], ['Pre-orders & support', '“quote sent”, “reply posted”']];
  pubs.forEach(([t, s], i) => {
    const x = 40 + i * 310;
    b += box(x, 70, 290, 150, { fill: 'tealPale', stroke: 'tealMid', title: t, sub: s, titleSize: 21, subSize: 16.5 });
    b += arrow(x + 145, 222, x + 145, 324, { color: 'tealMid', label: 'posts', lx: x + 185, ly: 275, lsize: 16 });
  });
  b += txt(800, 35, 'DEPARTMENTS POST NEWS…', { size: 20, bold: true, color: 'grey' });
  const subs = [['Notifications', 'sends the in-app message and phone push to the right people', 'orange'], ['Payments', 'opens a bill as soon as an order exists', 'purple'], ['Logistics', 'creates the delivery job once payment is proven', 'green']];
  subs.forEach(([t, s, col], i) => {
    const x = 100 + i * 480;
    b += arrow(x + 210, 424, x + 210, 518, { color: col, label: 'listens', lx: x + 255, ly: 470, lsize: 16 });
    b += box(x, 525, 420, 150, { fill: 'white', stroke: col, sw: 3, title: t, sub: s, titleSize: 22, subSize: 17 });
  });
  b += txt(800, 725, '…AND OTHER DEPARTMENTS REACT. No department needs to know how the others work inside.', { size: 19, color: 'grey', italic: true });
  save('10-event-bus', W, H, b);
}

// ── 11 Data map ──────────────────────────────────────────────────────
{
  const W = 1600, H = 800; let b = '';
  const groups = [
    ['People & logins', 'tealMid', 'tealPale', ['User (customers)', 'StaffUser', 'StaffSession', 'PartnerApplication', 'DeliveryPartnerProfile', 'PartnerDocument', 'Address', 'Device (phones)']],
    ['Catalog', 'green', 'greenLight', ['Category', 'Product', 'ProductImage', 'ProductVariant', 'ProductReview', 'FoodCategory', 'FoodVendor', 'MenuItem', 'MenuItemOptionGroup', 'MenuItemOption']],
    ['Orders', 'orange', 'orangeLight', ['Order', 'OrderItem', 'PreOrderRequest', 'PreOrderImage', 'IdempotencyKey']],
    ['Laundry', 'purple', 'purpleLight', ['LaundryVendor', 'LaundryVendorReview', 'LaundryCatalogItem', 'LaundryOrder', 'LaundryItem']],
    ['Delivery & money', 'red', 'redLight', ['Delivery', 'DeliveryStatusEvent', 'Payment', 'DriverEarning', 'PayoutRequest', 'PartnerPayout']],
    ['Talking & running', 'amber', 'amberLight', ['Notification', 'SupportTicket', 'SupportTicketReply', 'Promotion', 'Faq', 'PlatformSetting', 'AdminAuditLog', 'MarketplaceVendor']],
  ];
  const bw = 490, gap = 30;
  groups.forEach(([t, col, light, list], i) => {
    const x = 35 + (i % 3) * (bw + gap), y = 30 + Math.floor(i / 3) * 385, h = 360;
    b += box(x, y, bw, h, { fill: light, stroke: col });
    b += txt(x + bw / 2, y + 34, t.toUpperCase() + '  (' + list.length + ')', { size: 21, bold: true, color: col });
    list.forEach((m, j) => {
      const mx = x + 18 + (j % 2) * 236, my = y + 68 + Math.floor(j / 2) * 56;
      b += `<rect x="${mx}" y="${my}" width="226" height="44" rx="8" fill="#FFFFFF" stroke="${c(col)}" stroke-width="1.5"/>`;
      b += txt(mx + 113, my + 22, m, { size: 16, color: 'ink' });
    });
  });
  save('11-data-map', W, H, b);
}

// ── 12 Security layers ───────────────────────────────────────────────
{
  const W = 1600, H = 800; let b = '';
  const rings = [
    ['red', 'Speed limits on every route (stricter on login, codes, payments)'],
    ['orange', 'Login token checked; staff sessions can be ended instantly'],
    ['amber', 'Role check: customer, partner, vendor, laundry staff, admin'],
    ['purple', 'Strict form checks: unknown fields are refused'],
    ['tealMid', 'Business rules: you only see your own orders, staff only their laundry'],
  ];
  const cx = 470, cy = 410;
  rings.forEach(([col], i) => {
    const r = 370 - i * 66;
    b += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c(col)}" opacity="${0.12 + i * 0.05}" stroke="${c(col)}" stroke-width="3"/>`;
  });
  b += `<circle cx="${cx}" cy="${cy}" r="78" fill="${c('teal')}"/>`;
  b += txt(cx, cy - 12, 'YOUR', { size: 24, bold: true, color: 'white' });
  b += txt(cx, cy + 20, 'DATA', { size: 24, bold: true, color: 'white' });
  rings.forEach(([col, t], i) => {
    const y = 70 + i * 92;
    b += badge(cx, cy - (370 - i * 66) + 30, i + 1, { fill: col, r: 20, size: 19 });
    b += badge(930, y + 4, i + 1, { fill: col, r: 22, size: 20 });
    b += txt(970, y + 4, wrap(t, 46), { size: 20, anchor: 'start', valign: 'middle', lh: 26 });
  });
  b += box(900, 540, 670, 230, { fill: 'tealPale', stroke: 'tealMid' });
  b += txt(1235, 575, 'PLUS', { size: 21, bold: true, color: 'tealMid' });
  b += txt(1235, 680, ['Passwords & codes stored scrambled (bcrypt)', 'Accounts lock after 5 wrong passwords', 'Paystack messages verified by signature', 'Unsafe settings stop the server starting', 'Admin actions written to an audit log'], { size: 18.5, lh: 29, valign: 'middle' });
  save('12-security-layers', W, H, b);
}

// ── 13 Audit scorecard ───────────────────────────────────────────────
{
  const W = 1600, H = 800; let b = '';
  const rows = [
    ['Payments & money safety', 'A', 'green', 'Server-side prices, signed webhooks, re-verified amounts, no double charging'],
    ['Login & access control', 'A', 'green', 'Roles, revocable staff sessions, lockouts, rate limits'],
    ['Automated tests', 'A', 'green', '708 tests in 49 suites, all passing; type check clean'],
    ['Code structure', 'A−', 'green', '18 clear departments, shared rules in one place'],
    ['Database changes', 'B+', 'amber', '39 additive migrations; 3 newest not yet tried on a real database'],
    ['Settings & config', 'B', 'amber', 'One documented setting (payment timeout) is silently ignored'],
    ['Operations & recovery', 'B', 'amber', 'Failed automatic refunds are only written to the server log'],
    ['Documentation', 'B', 'amber', 'Very detailed, but README still calls modules “stubbed”'],
    ['Third-party libraries', 'C', 'red', '16 known vulnerabilities (2 critical, 7 high); framework upgrade due'],
  ];
  b += txt(60, 40, 'AREA', { size: 18, bold: true, color: 'grey', anchor: 'start' });
  b += txt(560, 40, 'GRADE', { size: 18, bold: true, color: 'grey' });
  b += txt(660, 40, 'WHY', { size: 18, bold: true, color: 'grey', anchor: 'start' });
  rows.forEach(([a, g, col, why], i) => {
    const y = 70 + i * 80;
    b += `<rect x="40" y="${y}" width="1520" height="68" rx="12" fill="${c(i % 2 ? 'white' : 'tealPale')}"/>`;
    b += txt(60, y + 34, a, { size: 22, bold: true, anchor: 'start' });
    b += `<rect x="515" y="${y + 10}" width="90" height="48" rx="24" fill="${c(col)}"/>`;
    b += txt(560, y + 35, g, { size: 24, bold: true, color: 'white' });
    b += txt(660, y + 34, why, { size: 19.5, color: 'ink', anchor: 'start' });
  });
  save('13-audit-scorecard', W, H, b);
}

// ── 14 Deploy flow ───────────────────────────────────────────────────
{
  const W = 1600, H = 560; let b = '';
  const st = [
    ['Write code', 'on a laptop, with tests', 'tealMid'],
    ['Run tests', 'npm test – 708 checks', 'green'],
    ['Push to GitHub', 'main branch', 'tealMid'],
    ['Render builds', 'npm ci && npm run build', 'purple'],
    ['Update database', 'prisma migrate deploy', 'orange'],
    ['Go live', 'npm run start:prod', 'green'],
    ['Smoke test', 'quick checks from DEPLOYMENT.md', 'red'],
  ];
  const bw = 196, gap = 28, y = 90, bh = 170;
  st.forEach(([t, s, col], i) => {
    const x = 30 + i * (bw + gap);
    b += box(x, y, bw, bh, { fill: 'white', stroke: col, sw: 3, title: t, sub: s, titleSize: 21, subSize: 16 });
    b += badge(x + bw / 2, y - 2, i + 1, { fill: col, r: 20, size: 19 });
    if (i < st.length - 1) b += arrow(x + bw + 2, y + bh / 2, x + bw + gap - 2, y + bh / 2, { color: 'grey' });
  });
  b += box(30, 320, 760, 190, { fill: 'orangeLight', stroke: 'orange', title: 'Back up first', sub: 'Take a Supabase backup before every release. All migrations in this release only add things, but a backup makes any mistake reversible.', titleSize: 21, subSize: 17 });
  b += box(810, 320, 760, 190, { fill: 'redLight', stroke: 'red', title: 'Secrets never go in Git', sub: 'Passwords and keys live only in Render’s settings and a local .env file (which Git ignores). The server refuses to start in production with unsafe values.', titleSize: 21, subSize: 17 });
  save('14-deploy-flow', W, H, b);
}

Promise.all(jobs).then(() => console.log('images:', jobs.length)).catch((e) => { console.error(e); process.exit(1); });
