const $ = (id) => document.getElementById(id);
const money = (n) => (Number(n) || 0).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let settings = { language: 'en', currency: 'INR', rate_includes_tax: false };
// Money with the configured currency symbol, for headline totals.
const fmt = (n) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: settings.currency }).format(Number(n) || 0); } catch { return money(n); } };
const msg = (text, cls) => { $('scanMsg').innerHTML = text ? `<div class="msg ${cls}">${esc(text)}</div>` : ''; };

const TABS = ['setup', 'household', 'buyers', 'categories', 'scan', 'inventory', 'invoices', 'consumption', 'orders', 'aistats'];
const closeMenus = () => { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); $('mainNav').classList.remove('open'); $('navToggle').setAttribute('aria-expanded', 'false'); };
const showTab = (tab) => {
  if (TABS.includes(tab) && !authed) return openLogin(tab);
  ['home', ...TABS].forEach((t) => $(t).classList.toggle('hidden', t !== tab));
  document.querySelectorAll('.dd [data-tab]').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  $('accountMenu').classList.toggle('active', TABS.includes(tab) && tab !== 'scan');
  $('scanLink').classList.toggle('active', tab === 'scan');
  if (tab === 'setup') loadSetup();
  if (tab === 'categories') loadCategories();
  if (tab === 'household') loadHousehold();
  if (tab === 'buyers') loadBuyers();
  if (tab === 'inventory') loadInventory();
  if (tab === 'invoices') loadInvoices();
  if (tab === 'consumption') loadComposition();
  if (tab === 'aistats') loadUsage();
  if (tab === 'orders') loadOrderForm();
  scrollTo(0, 0);
};
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = (e) => { e.preventDefault(); closeMenus(); showTab(b.dataset.tab); });
document.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => { closeMenus(); showTab('home'); $(b.dataset.goto).scrollIntoView({ behavior: 'smooth' }); });
document.querySelectorAll('.mbtn').forEach((b) => b.onclick = (e) => {
  e.stopPropagation();
  const m = b.parentElement, was = m.classList.contains('open');
  document.querySelectorAll('.menu.open').forEach((x) => x.classList.remove('open'));
  m.classList.toggle('open', !was);
});
document.addEventListener('click', () => document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')));
// Signup: the email address is the User ID. The server detects the country from the IP and sets language, currency and starter categories.
const closeSignup = () => $('signupModal').classList.add('hidden');
$('signup').onclick = () => {
  ['suFamily', 'suPass', 'suPass2', 'suEmail'].forEach((id) => { $(id).style.borderColor = ''; });
  $('suErr').textContent = '';
  $('signupFields').classList.remove('hidden'); $('signupDone').classList.add('hidden');
  $('signupModal').classList.remove('hidden'); $('suFamily').focus();
};
$('signupClose').onclick = closeSignup;
$('signupModal').onclick = (e) => { if (e.target === $('signupModal')) closeSignup(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSignup(); });
$('suShow').onchange = () => ['suPass', 'suPass2'].forEach((id) => { $(id).type = $('suShow').checked ? 'text' : 'password'; });
$('signupForm').onsubmit = async (e) => {
  e.preventDefault();
  // Every field is mandatory: name the first empty one (whitespace-only counts as empty) and focus it.
  for (const [id, label] of [['suFamily', 'Family name'], ['suEmail', 'Email'], ['suPass', 'Password'], ['suPass2', 'Confirm password']]) {
    const blank = ['suPass', 'suPass2'].includes(id) ? !$(id).value : !$(id).value.trim();
    $(id).style.borderColor = blank ? '#b00020' : '';
    if (blank) { $(id).focus(); return $('suErr').textContent = `${label} is required.`; }
  }
  if ($('suPass').value !== $('suPass2').value) return $('suErr').textContent = 'Passwords do not match.';
  const r = await post('/signup', 'POST', { family_name: $('suFamily').value.trim(), password: $('suPass').value, confirm: $('suPass2').value, email: $('suEmail').value.trim() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    return $('suErr').textContent = j.error || 'Could not create the account.';
  }
  localStorage.setItem('ss_userid', j.userid); // remembered in this browser
  $('signupFields').classList.add('hidden'); $('signupDone').classList.remove('hidden');
  $('signupDone').innerHTML = `<div class="msg ok"><b>Account created.</b><br>Your login ID is <b>${esc(j.userid)}</b>.<br><br>You can log in now with this email and your password.</div><button type="button" class="primary" id="signupOk" style="width:100%;padding:11px">Log in</button>`;
  $('signupOk').onclick = () => { const id = j.userid; closeSignup(); openLogin(); $('loginUser').value = id; $('loginPass').focus(); };
  $('signupForm').reset();
};

// Feedback: public form, available without login.
const closeFb = () => $('fbModal').classList.add('hidden');
$('feedbackLink').onclick = (e) => { e.stopPropagation(); closeMenus(); $('fbStatus').textContent = ''; $('fbModal').classList.remove('hidden'); $('fbMsg').focus(); };
$('fbClose').onclick = closeFb;
$('fbModal').onclick = (e) => { if (e.target === $('fbModal')) closeFb(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeFb(); });
$('fbForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await post('/feedback', 'POST', { rating: $('fbRating').value, message: $('fbMsg').value.trim(), email: $('fbEmail').value.trim() });
  const j = await r.json().catch(() => ({}));
  $('fbStatus').innerHTML = `<div class="msg ${r.ok ? 'ok' : 'err'}">${esc(r.ok ? 'Thank you! Your feedback has been sent.' : j.error || 'Could not send feedback.')}</div>`;
  if (r.ok) { $('fbForm').reset(); setTimeout(closeFb, 1800); }
};
$('navToggle').onclick = (e) => { e.stopPropagation(); $('navToggle').setAttribute('aria-expanded', $('mainNav').classList.toggle('open')); };

document.querySelectorAll('.subnav button').forEach((b) => b.onclick = () => {
  b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  if (b.dataset.ai) { aiType = b.dataset.ai; loadUsage(); }
  if (b.dataset.stat === 'composition') loadComposition();
  if (b.dataset.stat === 'overstock') loadOverstock();
  if (b.dataset.stat === 'uncategorized') loadPattern();
  if (b.dataset.stat === 'channels') loadChannels();
  if (b.dataset.stat) document.querySelectorAll('.statpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'stat-' + b.dataset.stat));
  if (b.dataset.order) document.querySelectorAll('.orderpane').forEach((p) => p.classList.toggle('hidden', p.id !== 'order-' + b.dataset.order));
});

// --- AI stats: usage pattern by consumption type (daily / frequently / monthly) ---
let aiType = 'daily';
const AI_INTRO = {
  daily: 'Items tagged Daily in Inventory: how fast they are used, how long stock lasts, and whether buying keeps pace.',
  frequently: 'Items tagged Frequently, Weekly or Fortnightly: purchase rhythm against their usual cycle.',
  monthly: 'Items tagged Monthly: whether each monthly buy is used up within the month, and what is left over.',
};
const AI_BADGE = { 'OK': '', 'Restock soon': 'warn', 'Out of stock': 'err', 'Overstocked': 'warn', 'Buying too often': 'warn' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayBars = (title, vals, cls, label) => {
  const max = Math.max(...vals, 0);
  return `<h4>${title}</h4><div class="wd ${cls}">${vals.map((v, k) => `<div title="${DOW[k]}: ${label(v)}"><span>${v ? label(v) : ''}</span><i style="height:${max ? Math.round(v / max * 90) : 0}px"></i>${DOW[k]}</div>`).join('')}</div>`;
};
async function loadUsage() {
  $('aiIntro').textContent = AI_INTRO[aiType];
  const j = await (await fetch(`/api/stats/usage?type=${aiType}&days=${$('aiDays').value}`)).json();
  $('aiPeriod').textContent = `${j.start} to ${j.end} — total spend on these items ${fmt(j.total)}`;
  $('aiInsights').innerHTML = j.insights.length ? `<div class="msg warn"><strong>Insights</strong><ul>${j.insights.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>` : '';
  $('aiRows').innerHTML = j.rows.length ? j.rows.map((r) => `<tr>
    <td>${esc(r.description)}</td><td>${esc(r.category)}</td><td>${esc(r.type)}</td>
    <td class="num">${r.purchased} ${esc(r.uom)}</td><td class="num">${r.purchases}</td><td class="num">${r.avg_gap_days ?? '–'}</td>
    <td class="num">${r.consumed}</td><td class="num">${r.per_day || '–'}</td><td class="num">${r.balance}</td><td class="num">${r.days_left ?? '–'}</td>
    <td class="num">${money(r.spend)}</td><td class="num">${r.pct.toFixed(1)}%</td>
    <td><span class="badge ${AI_BADGE[r.status] || ''}">${esc(r.status)}</span></td></tr>`).join('')
    : '<tr><td colspan="13">No items are tagged for this pattern yet. Set the Stock In column in Inventory.</td></tr>';
  const spenders = j.rows.filter((r) => r.pct > 0).map((r) => ({ description: r.description, pct: r.pct }));
  $('aiShare').innerHTML = spenders.length ? '<h4>Share of spend</h4>' + stockBar(spenders) : '';
  $('aiWeekday').innerHTML = j.rows.length ? weekdayBars('Spend by weekday of purchase', j.by_weekday.spend, 'spend', money)
    + weekdayBars('Stock In entries by weekday', j.by_weekday.uses, '', String) : '';
}
$('aiDays').onchange = loadUsage;

// --- Order forms: probable next monthly order ---
async function loadOrderForm() {
  const sel = $('orderMonth');
  const j = await (await fetch('/api/orders/nextmonth' + (sel.value ? '?month=' + sel.value : ''))).json();
  if (!sel.options.length) sel.innerHTML = j.months.map((m) => `<option value="${m}">${m}</option>`).join('');
  sel.value = j.order_month;
  $('orderPeriod').innerHTML = `Probable order form for <strong>${esc(j.target_month)}</strong>` + (j.projected ? ' (balances projected forward)' : '') + '. ' + (j.in_window
    ? '<span class="badge">Third week: this form applies now</span>'
    : `<span class="badge warn">Applies in the third week (${esc(j.window_start)} to ${esc(j.window_end)}); shown for preview</span>`)
    + ` Estimated total ${fmt(j.total)}` + (j.skipped ? ` — ${j.skipped} item(s) with enough stock are not listed.` : '.');
  $('orderRows').innerHTML = j.rows.length ? j.rows.map((r) => `<tr>
    <td>${esc(r.description)}</td><td>${esc(r.category)}</td><td>${esc(r.basis)}</td>
    <td class="num">${r.purchased}</td><td class="num">${r.consumed}</td><td class="num">${r.balance}</td><td class="num">${r.monthly_need}</td>
    <td class="num"><strong>${r.order_qty}</strong></td><td>${esc(r.uom)}</td><td class="num">${money(r.est_cost)}</td>
    <td><span class="badge ${r.status === 'Restock' ? 'err' : 'warn'}">${esc(r.status)}</span></td></tr>`).join('')
    : '<tr><td colspan="11">Nothing to order: all items have enough stock for this month.</td></tr>';
}
$('orderMonth').onchange = loadOrderForm;

// --- Consumption stats: item composition % for a month ---
const COMP_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#64748b'];
const compColor = (i) => COMP_COLORS[i % COMP_COLORS.length];
const monthLabel = (m) => new Date(m + '-01T00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

// One cylinder whose height is split into slices proportional to each item's share (top 9 items, rest grouped as "Others").
function cylinderSvg(items) {
  const MAX = 9, segs = items.slice(0, MAX).map((it, i) => ({ name: it.description, pct: it.pct, color: compColor(i) }));
  const rest = items.slice(MAX).reduce((s, it) => s + it.pct, 0);
  if (rest > 0) segs.push({ name: 'Others', pct: rest, color: '#94a3b8' });
  const cx = 80, rx = 60, ry = 14, top = 24, H = 260, bottom = top + H;
  let y = top, body = '', labels = '';
  const pos = segs.map((s) => { const h = H * s.pct / 100, p = { ...s, y, h }; y += h; return p; });
  for (const s of [...pos].reverse()) {
    const yEnd = s.y + s.h;
    body += `<rect x="${cx - rx}" y="${s.y}" width="${2 * rx}" height="${s.h}" fill="${s.color}"/><ellipse cx="${cx}" cy="${yEnd}" rx="${rx}" ry="${ry}" fill="${s.color}"/>`;
  }
  for (const s of pos) if (s.h >= 14) labels += `<text x="${cx}" y="${s.y + s.h / 2 + ry / 2 + 4}" text-anchor="middle" font-size="14" fill="#fff" font-weight="600">${round1(s.pct)}%</text>`;
  const outline = `<path d="M${cx - rx} ${top} V${bottom} A${rx} ${ry} 0 0 0 ${cx + rx} ${bottom} V${top}" fill="none" stroke="#0003"/>`;
  const topCap = `<ellipse cx="${cx}" cy="${top}" rx="${rx}" ry="${ry}" fill="${pos[0].color}"/><ellipse cx="${cx}" cy="${top}" rx="${rx}" ry="${ry}" fill="#fff4" stroke="#0003"/>`;
  const legend = pos.map((s) => `<div><span class="sw" style="background:${s.color}"></span>${esc(s.name)} — ${round1(s.pct)}%</div>`).join('');
  return `<svg width="160" height="${bottom + ry + 4}" role="img" aria-label="Item composition cylinder chart">${body}${outline}${topCap}${labels}</svg><div class="legend">${legend}</div>`;
}
const round1 = (n) => Math.round(n * 10) / 10;

// Full-width stacked bar of each item's share (top 9 items, rest grouped as "Others"), with a legend below.
function stockBar(items) {
  const MAX = 9, segs = items.slice(0, MAX).map((it, i) => ({ name: it.description, pct: it.pct, color: compColor(i) }));
  const rest = items.slice(MAX).reduce((s, it) => s + it.pct, 0);
  if (rest > 0) segs.push({ name: 'Others', pct: rest, color: '#94a3b8' });
  return `<div class="bar" role="img" aria-label="Share of stock value by item">${segs.map((s) => `<span style="width:${s.pct}%;background:${s.color}" title="${esc(s.name)} — ${round1(s.pct)}%">${s.pct >= 5 ? round1(s.pct) + '%' : ''}</span>`).join('')}</div>`
    + `<div class="legend">${segs.map((s) => `<div><span class="sw" style="background:${s.color}"></span>${esc(s.name)} — ${round1(s.pct)}%</div>`).join('')}</div>`;
}

// Shared by the monthly stat reports: p is the element-id prefix, empty is the no-rows message.
async function loadMonthReport(p, endpoint, empty) {
  const month = $(p + 'Month');
  if (!month.value) month.value = new Date().toISOString().slice(0, 7);
  const j = await (await fetch(`/api/stats/${endpoint}?month=${month.value}`)).json();
  $(p + 'Period').textContent = `${monthLabel(j.month)} (${j.start} to ${j.end}) — total value ${money(j.total)}`;
  $(p + 'Rows').innerHTML = j.items.length ? j.items.map((it, i) => `<tr>
    <td><span class="sw" style="display:inline-block;width:10px;height:10px;margin-right:6px;background:${i < 9 ? compColor(i) : '#94a3b8'}"></span>${esc(it.description)}</td>
    <td>${esc(it.category)}</td><td>${esc(it.uom)}</td><td class="num">${it.quantity}</td><td class="num">${money(it.value)}</td><td class="num">${it.pct.toFixed(2)}%</td></tr>`).join('')
    : `<tr><td colspan="6">${empty}</td></tr>`;
  $(p + 'Foot').innerHTML = j.items.length ? `<tr><th colspan="4">Total</th><th class="num">${money(j.total)}</th><th class="num">100%</th></tr>` : '';
  $(p + 'Chart').innerHTML = j.items.length ? cylinderSvg(j.items) : '';
}
// Pie of each item's share (top 9 items, rest grouped as "Others"), with percentage labels on larger slices and a legend.
function pieSvg(items) {
  const MAX = 9, segs = items.slice(0, MAX).map((it, i) => ({ name: it.description, pct: it.pct, color: compColor(i) }));
  const rest = items.slice(MAX).reduce((s, it) => s + it.pct, 0);
  if (rest > 0) segs.push({ name: 'Others', pct: rest, color: '#94a3b8' });
  const cx = 120, cy = 120, r = 110, pt = (a, rad) => `${(cx + rad * Math.sin(a)).toFixed(2)} ${(cy - rad * Math.cos(a)).toFixed(2)}`;
  let a0 = 0, slices = '', labels = '';
  for (const s of segs) {
    const a1 = a0 + s.pct / 100 * 2 * Math.PI, mid = (a0 + a1) / 2;
    slices += s.pct >= 99.99 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.color}"><title>${esc(s.name)} — ${round1(s.pct)}%</title></circle>`
      : `<path d="M${cx} ${cy} L${pt(a0, r)} A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1, r)} Z" fill="${s.color}" stroke="#fff" stroke-width="1"><title>${esc(s.name)} — ${round1(s.pct)}%</title></path>`;
    if (s.pct >= 5) labels += `<text x="${pt(mid, r * 0.65).split(' ')[0]}" y="${+pt(mid, r * 0.65).split(' ')[1] + 4}" text-anchor="middle" font-size="14" font-weight="600" fill="#fff">${round1(s.pct)}%</text>`;
    a0 = a1;
  }
  const legend = segs.map((s) => `<div><span class="sw" style="background:${s.color}"></span>${esc(s.name)} — ${round1(s.pct)}%</div>`).join('');
  return `<svg width="240" height="240" role="img" aria-label="Item composition pie chart">${slices}${labels}</svg><div class="legend">${legend}</div>`;
}
async function loadPattern() {
  const month = $('patMonth');
  if (!month.value) month.value = new Date().toISOString().slice(0, 7);
  const j = await (await fetch(`/api/stats/pattern?month=${month.value}`)).json();
  const label = (t) => t === 'unset' ? 'Not set' : (CONSUMPTION.find(([v]) => v === t) || [, t])[1];
  $('patPeriod').textContent = `${monthLabel(j.month)} (${j.start} to ${j.end}) — total value ${money(j.total)}`;
  $('patRows').innerHTML = j.patterns.length ? j.patterns.map((p, i) => `<tr>
    <td><span style="display:inline-block;width:10px;height:10px;margin-right:6px;background:${compColor(i)}"></span>${esc(label(p.type))}</td>
    <td>${p.items.map(esc).join(', ')}</td><td class="num">${money(p.value)}</td><td class="num">${p.pct.toFixed(2)}%</td></tr>`).join('')
    : '<tr><td colspan="4">No purchases recorded in this month.</td></tr>';
  $('patFoot').innerHTML = j.patterns.length ? `<tr><th colspan="2">Total</th><th class="num">${money(j.total)}</th><th class="num">100%</th></tr>` : '';
  $('patChart').innerHTML = j.patterns.length ? pieSvg(j.patterns.map((p) => ({ description: label(p.type), pct: p.pct }))) : '';
}
$('patMonth').onchange = loadPattern;
const loadComposition =() => loadMonthReport('comp', 'composition', 'No purchases recorded in this month.');
async function loadOverstock() {
  const month = $('ovMonth');
  if (!month.value) month.value = new Date().toISOString().slice(0, 7);
  const j = await (await fetch(`/api/stats/overstock?month=${month.value}`)).json();
  $('ovPeriod').textContent = `${monthLabel(j.month)} (${j.start} to ${j.end}) — total value ${money(j.total)}`;
  $('ovRows').innerHTML = j.items.length ? j.items.map((it, i) => `<tr>
    <td><span class="sw" style="display:inline-block;width:10px;height:10px;margin-right:6px;background:${i < 9 ? compColor(i) : '#94a3b8'}"></span>${esc(it.description)}</td>
    <td>${esc(it.category)}</td><td>${esc(it.uom)}</td><td class="num">${it.purchased}</td><td class="num">${it.consumed}</td><td class="num">${it.quantity}</td></tr>`).join('')
    : '<tr><td colspan="6">No overstocked items — everything bought this month was used.</td></tr>';
  $('ovFoot').innerHTML = '';
  $('ovChart').innerHTML = j.items.length ? cylinderSvg(j.items) : '';
}
async function loadChannels() {
  const month = $('chMonth');
  if (!month.value) month.value = new Date().toISOString().slice(0, 7);
  const j = await (await fetch(`/api/stats/channels?month=${month.value}`)).json();
  const cap = (c) => c === 'online' ? 'Online' : 'Offline';
  $('chPeriod').textContent = `${monthLabel(j.month)} (${j.start} to ${j.end}) — ${j.purchases} purchase(s), total spend ${money(j.total)}`;
  $('chChannels').innerHTML = j.channels.length ? j.channels.map((c) => `<tr><td>${cap(c.channel)}</td><td class="num">${c.purchases}</td><td class="num">${money(c.spend)}</td>
    <td class="num">${c.pct.toFixed(2)}%</td><td class="num">${money(c.discount)}</td><td class="num">${c.discount_pct.toFixed(2)}%</td></tr>`).join('')
    : '<tr><td colspan="6">No purchases recorded in this month.</td></tr>';
  $('chRows').innerHTML = j.vendors.length ? j.vendors.map((v, i) => `<tr>
    <td><span style="display:inline-block;width:10px;height:10px;margin-right:6px;background:${i < 9 ? compColor(i) : '#94a3b8'}"></span>${esc(v.vendor)}</td>
    <td>${cap(v.channel)}</td><td class="num">${v.purchases}</td><td class="num">${money(v.spend)}</td><td class="num">${v.pct.toFixed(2)}%</td>
    <td class="num">${money(v.discount)}</td><td class="num">${v.discount_pct.toFixed(2)}%</td></tr>`).join('')
    : '<tr><td colspan="7">No purchases recorded in this month.</td></tr>';
  $('chFoot').innerHTML = j.vendors.length ? `<tr><th colspan="2">Total</th><th class="num">${j.purchases}</th><th class="num">${money(j.total)}</th><th class="num">100%</th><th></th><th></th></tr>` : '';
  const slices = j.vendors.filter((v) => v.pct > 0).map((v) => ({ description: `${v.vendor} (${cap(v.channel).toLowerCase()})`, pct: v.pct }));
  $('chChart').innerHTML = slices.length ? pieSvg(slices) : '';
}
function printReport(p, title) { const t = document.title; document.title = title + ' ' + $(p + 'Month').value; window.print(); document.title = t; }
$('compMonth').onchange = loadComposition;
$('ovMonth').onchange = loadOverstock;
$('chMonth').onchange = loadChannels;
$('chPdf').onclick = () => printReport('ch', 'Online and offline purchases');
$('compPdf').onclick =() => printReport('comp', 'Item composition');
$('ovPdf').onclick = () => printReport('ov', 'Overstocked items');

let lineCats = [];
const USED_BY = [['everyone', 'Everyone'], ['male', 'Male'], ['female', 'Female'], ['children', 'Children']];
const usedByOptions = (sel) => USED_BY.map(([v, t]) => `<option value="${v}"${v === (sel || 'everyone') ? ' selected' : ''}>${t}</option>`).join('');
const CONSUMPTION = [['daily', 'Daily'], ['frequently', 'Frequently'], ['weekly', 'Weekly'], ['fortnightly', 'Fortnightly'], ['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['occasional', 'Occasional']];
const consumptionOptions = (sel, blank) => (blank ? '<option value="">— select —</option>' : '') + CONSUMPTION.map(([v, t]) => `<option value="${v}"${v === (sel || '') ? ' selected' : ''}>${t}</option>`).join('');
function addLine(l = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="d" value="${esc(l.description)}"></td>
    <td><select class="cat"><option value="">— none —</option>${lineCats.map((c) => `<option value="${c.id}"${c.id === l.category_id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
    <td><select class="ub">${usedByOptions(l.used_by)}</select></td>
    <td><select class="ct">${consumptionOptions(l.consumption_type, true)}</select></td>
    <td><input class="q" type="number" step="any" value="${l.quantity ?? 1}"></td>
    <td><input class="u" value="${esc(l.uom || 'pcs')}"></td>
    <td><input class="mrp" type="number" step="any" min="0" placeholder="optional" value="${l.mrp ? money(l.mrp) : ''}"></td>
    <td><input class="r" type="number" step="any" value="${money(l.rate)}"></td>
    <td class="num dp"></td>
    <td><input class="tp" type="number" step="any" min="0" value="${l.tax_pct ?? 0}"></td>
    <td><input class="a" type="number" step="any" min="0"></td>
    <td class="dup"></td>
    <td><button class="x">✕</button></td>`;
  tr.oninput = (e) => {
    // Typing an amount overrides the computed one; changing qty, rates or tax goes back to computing it.
    if (e.target.matches('.a')) e.target.dataset.manual = '1';
    else if (e.target.matches('.q, .mrp, .r, .tp')) delete tr.querySelector('.a').dataset.manual;
    recalc(); if (e.target.matches('.d, .u')) checkDupsSoon(); };
  // Rates always show two decimals once the field is left.
  tr.querySelectorAll('.mrp, .r').forEach((inp) => inp.onchange = () => { if (inp.value !== '') inp.value = money(inp.value); });
  tr.querySelector('.ct').onchange = (e) => { e.target.dataset.touched = '1'; };
  tr.querySelector('.x').onclick = () => { tr.remove(); recalc(); };
  $('lines').appendChild(tr);
  recalc();
}

function readLines() {
  return [...$('lines').rows].map((tr) => ({
    description: tr.querySelector('.d').value,
    category_id: tr.querySelector('.cat').value,
    used_by: tr.querySelector('.ub').value,
    consumption_type: tr.querySelector('.ct').value,
    quantity: parseFloat(tr.querySelector('.q').value) || 0,
    uom: tr.querySelector('.u').value,
    mrp: parseFloat(tr.querySelector('.mrp').value) || null,
    rate: parseFloat(tr.querySelector('.r').value) || 0,
    tax_pct: parseFloat(tr.querySelector('.tp').value) || 0,
    amount: tr.querySelector('.a').dataset.manual ? parseFloat(tr.querySelector('.a').value) || 0 : null,
    shown: parseFloat(tr.querySelector('.a').value) || 0, // what the Amount box currently displays (the rounded computed value)
    action: tr.querySelector('.act')?.value || 'add',
  }));
}

// Warn on lines that match an item already in inventory, and let the user choose to add to it or overwrite it.
let dupTimer;
const checkDupsSoon = () => { clearTimeout(dupTimer); dupTimer = setTimeout(checkDups, 400); };
async function checkDups() {
  const rows = [...$('lines').rows];
  if (!rows.length) return;
  const r = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: readLines() }) });
  const matches = await r.json();
  rows.forEach((tr, i) => {
    const cell = tr.querySelector('.dup'), m = matches[i], prev = tr.querySelector('.act')?.value;
    const ct = tr.querySelector('.ct');
    if (m?.consumption_type && !ct.dataset.touched) ct.value = m.consumption_type;
    if (!m) { cell.innerHTML = ''; return; }
    cell.innerHTML = `⚠ Already in inventory: "${esc(m.description)}" (${m.quantity} ${esc(m.uom)})
      <select class="act"><option value="add">Add to stock</option><option value="update">Update (set qty)</option></select>`;
    if (prev) cell.querySelector('.act').value = prev;
  });
}

function recalc() {
  let sub = 0, itemDisc = 0;
  const lines = readLines();
  [...$('lines').rows].forEach((tr, i) => {
    const l = lines[i];
    // Rate 2 is already the (possibly discounted) price paid; the item discount is only known when Rate 1 (MRP) is given.
    const disc = l.mrp > l.rate ? (l.mrp - l.rate) / l.mrp * 100 : 0;
    tr.querySelector('.dp').textContent = l.mrp ? disc.toFixed(2) : '–';
    if (l.mrp > l.rate) itemDisc += l.quantity * (l.mrp - l.rate);
    const aIn = tr.querySelector('.a');
    // A computed amount is rounded to the nearest whole number; an amount typed by hand is kept exactly as entered.
    const amt = l.amount ?? Math.round(l.quantity * l.rate * (settings.rate_includes_tax ? 1 : 1 + l.tax_pct / 100));
    sub += amt;
    if (!aIn.dataset.manual) aIn.value = amt;
  });
  const total = sub - (parseFloat($('invDiscount').value) || 0) + (parseFloat($('invTax').value) || 0);
  $('subtotal').textContent = fmt(sub);
  $('itemDisc').textContent = fmt(itemDisc);
  $('totDisc').textContent = fmt(itemDisc + (parseFloat($('invDiscount').value) || 0));
  $('total').textContent = fmt(total);
  const printed = parseFloat($('printed').value);
  $('mismatch').innerHTML = printed && Math.abs(printed - total) > 0.01
    ? `<div class="msg warn">Printed total (${money(printed)}) differs from computed (${money(total)}) — a line was misread.</div>` : '';
}
$('printed').oninput = $('invDiscount').oninput = $('invTax').oninput = recalc;

const syncChannel = () => $('providerLbl').classList.toggle('hidden', $('channel').value !== 'online');
$('channel').onchange = syncChannel;

async function showReview(inv = {}) {
  lineCats = (await (await fetch('/api/categories')).json()).categories;
  $('review').classList.remove('hidden');
  loadBuyerSelect();
  $('channel').value = inv.purchase_channel === 'online' ? 'online' : 'offline';
  $('provider').value = inv.provider || '';
  syncChannel();
  $('vendor').value = inv.vendor || '';
  $('date').value = inv.invoice_date || '';
  $('printed').value = inv.printed_total ?? '';
  $('invDiscount').value = inv.invoice_discount || '';
  $('invTax').value = inv.invoice_tax || '';
  $('lines').innerHTML = '';
  (inv.items?.length ? inv.items : [{}]).forEach(addLine);
  recalc();
  checkDups();
}

$('manualBtn').onclick = () => { msg(''); showReview(); };
$('addLine').onclick = () => addLine();

// Snap photo: phones open the camera app via the capture input; desktops use a webcam preview.
const useFile = (f) => { const dt = new DataTransfer(); dt.items.add(f); $('file').files = dt.files; msg(''); };
const SNAP_TIP = 'Please clean your camera lens and retake the photo, or upload a clear PDF/image file instead for the best results.';
let snapped = false;
$('file').addEventListener('change', () => { snapped = false; });
// Rough quality check on a captured canvas: flags dark or blurry shots (low edge contrast) before the user spends a scan on them.
const photoProblem = (src) => {
  const w = 480, h = Math.max(1, Math.round(src.height * w / src.width)), c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < g.length; i++) { g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; sum += g[i]; }
  if (sum / g.length < 50) return 'The photo is too dark.';
  let n = 0, s = 0, s2 = 0;
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const k = j * w + i, l = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w];
    n++; s += l; s2 += l * l;
  }
  return s2 / n - (s / n) ** 2 < 40 ? 'The photo looks blurry or unclear.' : '';
};
let camStream = null;
const closeCam = () => { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; $('camVideo').srcObject = null; $('camModal').classList.add('hidden'); };
$('snapInput').onchange = () => { if ($('snapInput').files[0]) { useFile($('snapInput').files[0]); snapped = true; } $('snapInput').value = ''; };
// Guide frame (portrait, ~invoice shape) in video pixels; the same rectangle is drawn on screen and used to crop the capture.
const camRect = (v) => {
  let h = v.videoHeight * 0.9, w = h * 0.72;
  if (w > v.videoWidth * 0.92) { w = v.videoWidth * 0.92; h = w / 0.72; }
  return { x: (v.videoWidth - w) / 2, y: (v.videoHeight - h) / 2, w, h };
};
const placeFrame = () => {
  const v = $('camVideo'); if (!v.videoWidth) return;
  const r = camRect(v), s = $('camFrame').style;
  s.left = `${r.x / v.videoWidth * 100}%`; s.top = `${r.y / v.videoHeight * 100}%`; s.width = `${r.w / v.videoWidth * 100}%`; s.height = `${r.h / v.videoHeight * 100}%`;
};
$('camVideo').onloadedmetadata = placeFrame;
$('snapBtn').onclick = async () => {
  if (!navigator.mediaDevices?.getUserMedia) return $('snapInput').click();
  $('camErr').textContent = ''; $('camModal').classList.remove('hidden');
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
    $('camVideo').srcObject = camStream;
  } catch { $('camErr').textContent = 'Camera not available or permission denied. Use Choose File instead.'; }
};
$('camShot').onclick = () => {
  const v = $('camVideo');
  if (!camStream || !v.videoWidth) return;
  const r = camRect(v), c = document.createElement('canvas');
  c.width = Math.round(r.w); c.height = Math.round(r.h);
  c.getContext('2d').drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const problem = photoProblem(c);
  c.toBlob((b) => {
    if (b) { useFile(new File([b], `invoice-${Date.now()}.jpg`, { type: 'image/jpeg' })); snapped = true; }
    closeCam();
    if (problem) msg(`${problem} ${SNAP_TIP}`, 'warn');
  }, 'image/jpeg', 0.92);
};
$('camClose').onclick = closeCam;
$('camModal').onclick = (e) => { if (e.target === $('camModal')) closeCam(); };

$('scanBtn').onclick = async () => {
  const f = $('file').files[0];
  if (!f) return msg('Choose an invoice image or PDF first.', 'err');
  if (!/^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.type)) return msg('Unsupported file type. Choose a JPG, PNG, WEBP, GIF or PDF.', 'err');
  if (!f.size) return msg('That file is empty.', 'err');
  if (f.size > 20 * 1024 * 1024) return msg('That file is larger than 20 MB. Choose a smaller photo or PDF.', 'err');
  msg('Scanning… this can take a few seconds.', 'warn');
  $('scanBtn').disabled = true;
  try {
    const fd = new FormData(); fd.append('invoice', f);
    const r = await fetch('/api/scan', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({ error: 'Unexpected response from the server.' }));
    if (!r.ok) { $('review').classList.add('hidden'); return msg(r.status === 422 && snapped ? `${j.error} ${SNAP_TIP}` : j.error, 'err'); }
    if (j.warnings?.length)
      $('scanMsg').innerHTML = `<div class="msg warn"><b>Scan complete, but please check these before saving:</b><ul>${j.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
    else msg('Scan complete — review and correct the lines below, then save.', 'ok');
    showReview(j);
  } catch (e) {
    msg('Scan failed: ' + e.message, 'err');
  } finally { $('scanBtn').disabled = false; }
};

$('save').onclick = async () => {
  if (!$('buyer').value) return msg('Select the buyer for this invoice.', 'err');
  const bad = readLines().find((l) => l.description.trim() && !(Number(l.quantity) > 0 && Number(l.rate) >= 0));
  if (bad) return msg(`Enter a quantity above 0 and a valid rate for "${bad.description}".`, 'err');
  const noCt = readLines().find((l) => l.description.trim() && !l.consumption_type);
  if (noCt) return msg(`Select a Stock In value for "${noCt.description}".`, 'err');
  const r = await fetch('/api/invoices', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyer_id: $('buyer').value, channel: $('channel').value, provider: $('provider').value, vendor: $('vendor').value, invoice_date: $('date').value,
      printed_total: parseFloat($('printed').value) || null,
      invoice_discount: parseFloat($('invDiscount').value) || 0, invoice_tax: parseFloat($('invTax').value) || 0, items: readLines().map((l) => ({ ...l, amount: l.amount ?? l.shown })),
    }),
  });
  const j = await r.json();
  if (!r.ok) return msg(j.error, 'err');
  msg(`Saved invoice #${j.id} (value ${money(j.computed_total)}). Inventory updated.`, 'ok');
  $('review').classList.add('hidden'); $('file').value = '';
};

// Client-side paging: all rows stay in the DOM (so totals/% of total cover every row) and rows outside the current page are hidden.
const PAGE_SIZE = 25, pageNo = {};
function paginate(key, tbodyId, pagerId, rowSel, reset) {
  const rows = [...$(tbodyId).querySelectorAll(rowSel)], pager = $(pagerId);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = pageNo[key] = Math.min(Math.max(reset ? 1 : pageNo[key] || 1, 1), pages);
  rows.forEach((tr, k) => { tr.hidden = Math.floor(k / PAGE_SIZE) + 1 !== p; });
  $(tbodyId).querySelectorAll('tr.detail').forEach((d) => d.remove());
  $(tbodyId).querySelectorAll('tr.inv').forEach((tr) => { tr.cells[0].textContent = '▸ ' + tr.dataset.id; });
  pager.innerHTML = pages > 1 ? `<button class="prev"${p === 1 ? ' disabled' : ''}>‹ Prev</button> Page ${p} of ${pages} (${rows.length} rows) <button class="next"${p === pages ? ' disabled' : ''}>Next ›</button>` : '';
  if (pages > 1) {
    pager.querySelector('.prev').onclick = () => { pageNo[key] = p - 1; paginate(key, tbodyId, pagerId, rowSel); };
    pager.querySelector('.next').onclick = () => { pageNo[key] = p + 1; paginate(key, tbodyId, pagerId, rowSel); };
  }
}

async function loadInventory() {
  const [j, cats] = await Promise.all([fetch('/api/inventory').then((r) => r.json()), fetch('/api/categories').then((r) => r.json())]);
  const catOptions = (sel) => '<option value="">— none —</option>' + cats.categories.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  $('invValue').textContent = fmt(j.total_value);
  const low = j.items.filter((i) => i.min_qty > 0 && i.quantity - i.used_qty <= i.min_qty);
  $('lowBanner').innerHTML = low.length ? `<div class="msg warn">Low stock: ${low.map((i) => esc(i.description)).join(', ')}</div>` : '';
  $('invRows').innerHTML = j.items.map((i) => `<tr data-id="${i.id}" class="${i.min_qty > 0 && i.quantity - i.used_qty <= i.min_qty ? 'low' : ''}">
    <td>${esc(i.description)}</td>
    <td><select class="cat">${catOptions(i.category_id)}</select></td>
    <td><select class="ub">${usedByOptions(i.used_by)}</select></td>
    <td><select class="ct">${consumptionOptions(i.consumption_type, true)}</select></td>
    <td><input class="q" type="number" step="any" value="${i.quantity}"></td>
    <td>${esc(i.uom)}</td>
    <td><input class="uq" type="number" step="any" min="0" value="${Math.round((i.used_qty || 0) * 100) / 100}"></td>
    <td class="num bal"></td>
    <td><input class="r" type="number" step="any" value="${Math.round((i.avg_rate || 0) * 100) / 100}"></td>
    <td class="num val"></td>
    <td class="num pct"></td>
    <td><button class="c" title="Use / consume" aria-label="Use">−</button> <button class="s" title="Save" aria-label="Save">✔</button> <button class="d" title="Delete" aria-label="Delete">✖</button></td></tr>`).join('');
  // Value = total purchased qty x avg rate; share = value / total inventory value. Recomputed live as rows are edited.
  const refreshValues = () => {
    const rows = [...$('invRows').rows];
    const bals = rows.map((tr) => (parseFloat(tr.querySelector('.q').value) || 0) - (parseFloat(tr.querySelector('.uq').value) || 0));
    // Value is on total purchased qty, so consuming stock changes the balance but not the value.
    const vals = rows.map((tr) => (parseFloat(tr.querySelector('.q').value) || 0) * (parseFloat(tr.querySelector('.r').value) || 0));
    const total = vals.reduce((s, v) => s + v, 0);
    rows.forEach((tr, k) => {
      tr.querySelector('.bal').textContent = Math.round(bals[k] * 100) / 100;
      tr.querySelector('.val').textContent = money(vals[k]);
      tr.querySelector('.pct').textContent = total > 0 ? (vals[k] / total * 100).toFixed(1) + '%' : '–';
    });
    $('invValue').textContent = fmt(total);
    // Same cylinder as the composition report, driven by each item's share of current stock value.
    const shares = rows.map((tr, k) => ({ description: tr.cells[0].textContent, pct: total > 0 ? Math.max(vals[k], 0) / total * 100 : 0 }))
      .filter((s) => s.pct > 0).sort((a, b) => b.pct - a.pct);
    $('invChart').innerHTML = shares.length ? stockBar(shares) : '';
  };
  refreshValues();
  $('invRows').querySelectorAll('tr').forEach((tr) => {
    const id = tr.dataset.id;
    tr.oninput = refreshValues;
    tr.querySelector('.s').onclick = async () => {
      await fetch('/api/inventory/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: tr.querySelector('.q').value, used_qty: tr.querySelector('.uq').value, avg_rate: tr.querySelector('.r').value, category_id: tr.querySelector('.cat').value, used_by: tr.querySelector('.ub').value, consumption_type: tr.querySelector('.ct').value }) });
      loadInventory();
    };
    tr.querySelector('.c').onclick = async () => {
      const q = parseFloat(prompt('Quantity used/consumed?', '1'));
      if (!(q > 0)) return;
      await fetch('/api/inventory/' + id + '/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantity: q }) });
      loadInventory();
    };
    tr.querySelector('.d').onclick = async () => {
      if (confirm('Remove this item from inventory?')) { await fetch('/api/inventory/' + id, { method: 'DELETE' }); loadInventory(); }
    };
  });
  filterInventory();
}

// Search as you type: every word must appear (any order, case-insensitive) in the item name or its category.
function filterInventory(reset) {
  const words = $('invSearch').value.toLowerCase().split(/\s+/).filter(Boolean), rows = [...$('invRows').rows];
  let shown = 0;
  for (const tr of rows) {
    const text = (tr.cells[0].textContent + ' ' + (tr.querySelector('.cat').selectedOptions[0]?.textContent || '')).toLowerCase();
    const ok = words.every((w) => text.includes(w));
    if (ok) { tr.removeAttribute('data-nomatch'); shown++; } else { tr.dataset.nomatch = '1'; tr.hidden = true; }
  }
  $('invSearchCount').textContent = words.length ? (shown ? `${shown} of ${rows.length} items` : 'No matching items') : '';
  paginate('inv', 'invRows', 'invPager', 'tr:not([data-nomatch])', reset);
}
$('invSearch').oninput = () => filterInventory(true);

const post = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const flash = (id, text, cls) => { $(id).innerHTML = text ? `<div class="msg ${cls}">${esc(text)}</div>` : ''; };
const HH_FIELDS = { hhPersons: 'persons', hhChildren: 'children', hhAdults: 'adults', hhMales: 'males', hhFemales: 'females' };

const LANG_NAMES = { en: 'English', hi: 'हिन्दी (Hindi)', mr: 'मराठी (Marathi)', es: 'Español', fr: 'Français', de: 'Deutsch' };
const CUR_NAMES = { USD: 'US Dollar (USD)', GBP: 'Pound (GBP)', EUR: 'Euro (EUR)', AUD: 'Australian Dollar (AUD)', CAD: 'Canadian Dollar (CAD)', JPY: 'Japanese Yen (JPY)', SGD: 'Singapore Dollar (SGD)', INR: 'Indian Rupee (INR)' };
async function loadSetup() {
  const j = await (await fetch('/api/settings')).json();
  settings = j.settings;
  $('setLang').innerHTML = j.languages.map((l) => `<option value="${l}">${LANG_NAMES[l] || l}</option>`).join('');
  $('setCur').innerHTML = j.currencies.map((c) => `<option value="${c}">${CUR_NAMES[c] || c}</option>`).join('');
  $('setLang').value = settings.language;
  $('setCur').value = settings.currency;
  $('setTax').value = settings.rate_includes_tax ? '1' : '0';
  flash('setMsg', '');
}
$('setSave').onclick = async () => {
  const r = await post('/api/settings', 'PUT', { language: $('setLang').value, currency: $('setCur').value, rate_includes_tax: $('setTax').value === '1' });
  const j = await r.json();
  if (r.ok) { settings = j.settings; recalc(); }
  flash('setMsg', r.ok ? 'Settings saved.' : j.error, r.ok ? 'ok' : 'err');
};
$('pwShow').onchange = () => ['pwCur', 'pwNew', 'pwNew2'].forEach((id) => { $(id).type = $('pwShow').checked ? 'text' : 'password'; });
$('pwForm').onsubmit = async (e) => {
  e.preventDefault();
  if ($('pwNew').value !== $('pwNew2').value) return flash('pwMsg', 'New passwords do not match.', 'err');
  const r = await post('/api/change-password', 'POST', { current: $('pwCur').value, next: $('pwNew').value });
  const j = await r.json().catch(() => ({}));
  if (r.ok) { $('pwForm').reset(); $('pwShow').onchange(); }
  flash('pwMsg', r.ok ? 'Password changed. Use it next time you log in.' : j.error || 'Could not change password.', r.ok ? 'ok' : 'err');
};
const loadSettingsInit = () => fetch('/api/settings').then((r) => r.json()).then((j) => { if (j.settings) { settings = j.settings; recalc(); } });

async function loadHousehold() {
  const j = await (await fetch('/api/household')).json(), h = j.household;
  $('hhAges').innerHTML = j.age_group_labels.map((g) => `<label>${g}<input data-age="${g}" type="number" min="0" value="${h?.age_groups[g] ?? 0}"></label>`).join('');
  $('hhCode').value = j.userid; // the household's Unique ID is the account's User ID
  $('hhName').value = h?.family_name || j.family_name;
  for (const [id, k] of Object.entries(HH_FIELDS)) $(id).value = h?.[k] ?? 0;
  flash('hhMsg', '');
}
$('hhSave').onclick = async () => {
  const age_groups = {};
  $('hhAges').querySelectorAll('input').forEach((i) => { age_groups[i.dataset.age] = i.value; });
  const body = { family_name: $('hhName').value, age_groups };
  for (const [id, k] of Object.entries(HH_FIELDS)) body[k] = $(id).value;
  const r = await post('/api/household', 'PUT', body);
  flash('hhMsg', r.ok ? 'Household saved.' : (await r.json()).error, r.ok ? 'ok' : 'err');
};

async function loadBuyers() {
  const j = await (await fetch('/api/buyers')).json();
  $('buyCode').value = j.next_code; $('buyName').value = '';
  $('buyAdd').disabled = !j.max || j.buyers.length >= j.max;
  $('buyMax').textContent = j.max ? `${j.buyers.length} of ${j.max} persons in the household` : '';
  $('buyRows').innerHTML = j.buyers.map((b) => `<tr><td>${esc(b.code)}</td><td>${esc(b.name)}</td><td><button data-id="${b.id}">Delete</button></td></tr>`).join('');
  $('buyRows').querySelectorAll('button').forEach((btn) => btn.onclick = async () => {
    const r = await fetch('/api/buyers/' + btn.dataset.id, { method: 'DELETE' });
    if (!r.ok) return flash('buyMsg', (await r.json()).error, 'err');
    await loadBuyers(); flash('buyMsg', '');
  });
  if (!j.max) flash('buyMsg', 'Set up the household first (menu 1).', 'warn');
}
$('buyAdd').onclick = async () => {
  const r = await post('/api/buyers', 'POST', { code: $('buyCode').value, name: $('buyName').value });
  if (!r.ok) return flash('buyMsg', (await r.json()).error, 'err');
  await loadBuyers(); flash('buyMsg', 'Buyer added.', 'ok');
};

async function loadCategories() {
  const j = await (await fetch('/api/categories')).json();
  $('catCode').value = j.next_code; $('catName').value = ''; $('catDesc').value = ''; $('catPct').value = 0;
  $('catTotal').textContent = `Allocated ${j.allocated}% of monthly budget — ${Math.round((100 - j.allocated) * 100) / 100}% unallocated`;
  $('catRows').innerHTML = j.categories.map((c) => `<tr data-id="${c.id}">
    <td><input class="k" value="${esc(c.code)}"></td><td><input class="n" value="${esc(c.name)}"></td>
    <td><input class="d" value="${esc(c.description)}"></td>
    <td><input class="p" type="number" step="any" min="0" max="100" value="${c.budget_pct}"></td>
    <td>${c.item_count}</td><td><button class="s">Save</button> <button class="x">Delete</button></td></tr>`).join('');
  $('catRows').querySelectorAll('tr').forEach((tr) => {
    tr.querySelector('.s').onclick = async () => {
      const r = await post('/api/categories/' + tr.dataset.id, 'PUT', {
        code: tr.querySelector('.k').value, name: tr.querySelector('.n').value, description: tr.querySelector('.d').value, budget_pct: tr.querySelector('.p').value });
      if (!r.ok) return flash('catMsg', (await r.json()).error, 'err');
      await loadCategories(); flash('catMsg', 'Category saved.', 'ok');
    };
    tr.querySelector('.x').onclick = async () => {
      if (!confirm('Delete this category? Its items stay in inventory, uncategorised.')) return;
      await fetch('/api/categories/' + tr.dataset.id, { method: 'DELETE' });
      await loadCategories(); flash('catMsg', '');
    };
  });
}
$('catAdd').onclick = async () => {
  const r = await post('/api/categories', 'POST', { code: $('catCode').value, name: $('catName').value, description: $('catDesc').value, budget_pct: $('catPct').value });
  if (!r.ok) return flash('catMsg', (await r.json()).error, 'err');
  await loadCategories(); flash('catMsg', 'Category added.', 'ok');
};

async function loadBuyerSelect() {
  const j = await (await fetch('/api/buyers')).json(), cur = $('buyer').value;
  $('buyer').innerHTML = '<option value="">— select —</option>' + j.buyers.map((b) => `<option value="${b.id}">${esc(b.code)} · ${esc(b.name)}</option>`).join('');
  $('buyer').value = cur;
}

// Search as you type: invoices containing an item (name or category) or vendor with every typed word are kept; the search stays when the list reloads.
const searchWords = () => $('invoiceSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
function filterInvoices(reset) {
  const words = searchWords(), rows = [...$('invList').querySelectorAll('tr.inv')];
  let shown = 0;
  for (const tr of rows) {
    // Every word must appear on one item line (or the vendor), not scattered across different items.
    const ok = !words.length || (tr.dataset.text.split('\n').some((line) => words.every((w) => line.includes(w))) || words.every((w) => (tr.cells[3].textContent || '').toLowerCase().includes(w)));
    if (ok) { tr.removeAttribute('data-nomatch'); shown++; } else { tr.dataset.nomatch = '1'; tr.hidden = true; }
  }
  $('invoiceSearchCount').textContent = words.length ? (shown ? `${shown} of ${rows.length} invoices` : 'No matching invoices') : '';
  paginate('invoices', 'invList', 'invListPager', 'tr.inv:not([data-nomatch])', reset);
}
$('invoiceSearch').oninput = () => filterInvoices(true);

async function loadInvoices() {
  const rows = await (await fetch('/api/invoices')).json();
  $('invList').innerHTML = rows.map((i) => `<tr class="inv" data-id="${i.id}" data-text="${esc(((i.items_text || '') + ' ' + (i.vendor || '')).toLowerCase())}" style="cursor:pointer" title="Click to show items"><td>▸ ${i.id}</td><td>${esc(i.buyer_code ? i.buyer_code + ' · ' + i.buyer_name : '')}</td><td>${i.channel === 'online' ? 'Online' + (i.provider ? ' · ' + esc(i.provider) : '') : 'Offline'}</td><td>${esc(i.vendor)}</td><td>${esc(i.invoice_date)}</td>
    <td class="num">${i.printed_total == null ? '' : money(i.printed_total)}</td><td class="num">${money(i.computed_total)}</td></tr>`).join('');
  filterInvoices(true);
  $('invList').querySelectorAll('tr.inv').forEach((tr) => tr.onclick = async () => {
    const open = tr.nextElementSibling?.classList.contains('detail');
    if (open) { tr.nextElementSibling.remove(); tr.cells[0].textContent = '▸ ' + tr.dataset.id; return; }
    const inv = await (await fetch('/api/invoices/' + tr.dataset.id)).json();
    const d = document.createElement('tr');
    d.className = 'detail';
    const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    const ctLabel = (v) => (CONSUMPTION.find(([k]) => k === v) || [, ''])[1];
    d.innerHTML = `<td colspan="7"><table><thead><tr><th>Description</th><th>Category</th><th>Used by</th><th>Stock In</th><th class="num">Qty</th><th>UOM</th><th class="num">Qty consumed</th><th>Date consumed</th><th class="num">MRP Rate</th><th class="num">Unit Rate</th><th class="num">Disc %</th><th class="num">Tax %</th><th class="num">Amount</th><th></th></tr></thead><tbody>${
      inv.items.map((x) => `<tr data-item="${x.id}"${searchWords().length && searchWords().every((w) => (x.description + ' ' + (x.category || '')).toLowerCase().includes(w)) ? ' style="background:#fff3b0"' : ''}><td>${esc(x.description)}</td><td>${esc(x.category || '')}</td><td>${esc(cap(x.used_by))}</td><td>${esc(ctLabel(x.consumption_type))}</td><td class="num">${x.quantity}</td><td>${esc(x.uom)}</td><td><input class="cq" type="number" step="any" min="0" max="${x.quantity}" value="${x.used_qty}"></td><td><input class="cd" type="date" value="${esc(x.used_date || '')}"></td><td class="num">${x.mrp ? money(x.mrp) : ''}</td><td class="num">${money(x.rate)}</td><td class="num">${x.discount_pct || 0}</td><td class="num">${x.tax_pct || 0}</td><td class="num">${money(x.amount)}</td><td><button class="cs">Save</button> <span class="cm"></span></td></tr>`).join('')
      + (inv.discount ? `<tr><td colspan="12" class="num">Invoice discount</td><td class="num">-${money(inv.discount)}</td><td></td></tr>` : '')
      + (inv.tax ? `<tr><td colspan="12" class="num">Invoice tax</td><td class="num">+${money(inv.tax)}</td><td></td></tr>` : '')
      || '<tr><td colspan="14">No items</td></tr>'}</tbody></table></td>`;
    d.querySelectorAll('button.cs').forEach((b) => b.onclick = async () => {
      const row = b.closest('tr'), msg = row.querySelector('.cm'), cq = row.querySelector('.cq');
      const ordered = parseFloat(cq.max);
      if (parseFloat(cq.value) > ordered) { cq.value = ordered; msg.textContent = `Cannot exceed qty ordered (${ordered}); set to ${ordered}.`; return; }
      const r = await post('/api/invoice-items/' + row.dataset.item, 'PATCH', { used_qty: row.querySelector('.cq').value, used_date: row.querySelector('.cd').value });
      const j = await r.json();
      if (!r.ok) { msg.textContent = j.error; return; }
      cq.value = j.used_qty; row.querySelector('.cd').value = j.used_date;
      msg.textContent = '✓ Saved' + (j.balance == null ? ' (no matching inventory item)' : ` · inventory balance ${j.balance} ${j.uom}`);
    });
    tr.after(d);
    tr.cells[0].textContent = '▾ ' + tr.dataset.id;
  });
}

// --- Login state: the landing page is public; app screens need a login (modal, no page change). ---
let authed = false, pendingTab = null;
const setAuthed = (v, who) => {
  authed = v; document.body.classList.toggle('authed', v); $('logout').textContent = v ? 'Logout' : 'Login';
  $('accountWho').innerHTML = v && who ? `Signed in as<b>${esc(who.family_name)}</b><span>${esc(who.userid)}</span>` : '';
};
const refreshSession = () => fetch('/session').then((r) => r.json()).then((j) => { setAuthed(j.loggedIn, j); if (j.loggedIn) loadSettingsInit(); });
const openLogin = (tab) => { pendingTab = tab || null; $('loginErr').textContent = ''; $('loginModal').classList.remove('hidden'); $('loginUser').focus(); };
$('loginShow').onchange = () => { $('loginPass').type = $('loginShow').checked ? 'text' : 'password'; };
const closeLogin = () => { $('loginModal').classList.add('hidden'); $('loginPass').value = ''; $('loginShow').checked = false; $('loginShow').onchange(); };
$('logout').onclick = async () => {
  closeMenus();
  if (!authed) return openLogin();
  await fetch('/logout', { method: 'POST' });
  setAuthed(false);
  if ($('home').classList.contains('hidden')) showTab('home');
};
$('loginClose').onclick = closeLogin;
$('loginModal').onclick = (e) => { if (e.target === $('loginModal')) closeLogin(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLogin(); });
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid: $('loginUser').value.trim(), password: $('loginPass').value }) });
  if (!r.ok) { $('loginErr').textContent = (await r.json().catch(() => ({}))).error || 'Login failed.'; return; }
  // Offer to save the credentials in the browser's password manager (the form is submitted with fetch, so do it explicitly).
  if (($('loginSave').checked) && window.PasswordCredential) navigator.credentials.store(new PasswordCredential({ id: $('loginUser').value.trim(), password: $('loginPass').value, name: 'Smartscan' })).catch(() => {});
  await refreshSession(); closeLogin();
  if (pendingTab) showTab(pendingTab);
};
refreshSession();

// App-store badges: until the real store URLs are set in index.html (href), show a notice instead of a dead link.
$('yr').textContent = new Date().getFullYear();
document.querySelectorAll('a[data-soon]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); alert(a.dataset.soon + ' coming soon.'); }));
document.querySelectorAll('a.store').forEach((a) => a.addEventListener('click', (e) => {
  if (a.getAttribute('href') === '#') { e.preventDefault(); alert(a.dataset.store + ' listing coming soon.'); }
}));
