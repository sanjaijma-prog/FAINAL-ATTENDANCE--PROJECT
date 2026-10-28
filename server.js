const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy (needed for secure cookies + rate limit)
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
require('fs').mkdirSync(DATA_DIR, { recursive: true });
app.use(express.static(path.join(__dirname, "public")));

const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) {
  console.error('Missing SUPABASE_URL. Set it in Render Environment Variables (or .env locally).');
  process.exit(1);
}
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY. Add it to .env (local) or Render Environment Variables.');
  process.exit(1);
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-in-production',
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

const ymd = d => (d || new Date()).toLocaleDateString('en-CA'); // YYYY-MM-DD in server time zone (TZ env)
const nowHM = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const errText = e => e?.message || 'Database operation failed';

function requireAdmin(req, res, next) { if (!req.session.admin) return res.status(401).json({ error: 'Admin login required' }); next(); }
function requireSuper(req, res, next) { if (!req.session.admin || req.session.admin.role !== 'super') return res.status(403).json({ error: 'Super admin access required' }); next(); }
function requireWorker(req, res, next) { if (!req.worker) return res.status(401).json({ error: 'Worker login required' }); next(); }
function publicAdmin(a) { return { id: a.id, username: a.username, name: a.name, email: a.email, role: a.role, status: a.status, createdAt: a.created_at }; }
function publicMember(m) { return { id: m.id, name: m.name, eid: m.eid, dept: m.dept }; }
function status(checkIn, checkOut) { return !checkIn ? 'Not checked in' : checkIn && !checkOut ? 'Working' : 'Checked out'; }

async function setting(key, fallback) {
  const { data, error } = await db.from('settings').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data ? data.value : fallback;
}
async function setSetting(key, value) {
  const { error } = await db.from('settings').upsert({ key, value });
  if (error) throw error;
}
async function ensureDefaults() {
  const company = await setting('companyName', null);
  if (company === null) await setSetting('companyName', 'JAI MARUTHI AUTOMATION');
}
async function getAttendanceFor(date) {
  const { data, error } = await db.from('attendance').select('member_id,check_in,check_out').eq('date', date);
  if (error) throw error;
  const out = {};
  for (const r of data || []) out[r.member_id] = { checkIn: r.check_in, checkOut: r.check_out };
  return out;
}
async function getOneAttendance(memberId, date) {
  const { data, error } = await db.from('attendance').select('*').eq('member_id', memberId).eq('date', date).maybeSingle();
  if (error) throw error;
  return data;
}
// counted = true -> the day counts as present (admin-entered, or the daily log was approved).
// counted = false -> a worker's own entry that is still waiting for admin approval (shown blank in reports).
// counted undefined -> keep the existing value (new rows created without a decision start as not counted).
async function setAttendance(memberId, date, type, time, counted) {
  const existing = await getOneAttendance(memberId, date);
  const row = {
    member_id: memberId,
    date,
    check_in: existing?.check_in || null,
    check_out: existing?.check_out || null,
    counted: counted === undefined ? (existing ? existing.counted !== false : false) : counted,
    updated_at: new Date().toISOString()
  };
  row[type === 'checkIn' ? 'check_in' : 'check_out'] = time;
  const { error } = await db.from('attendance').upsert(row, { onConflict: 'member_id,date' });
  if (error) throw error;
}
async function getTodayLog(memberId, date) {
  const { data, error } = await db.from('daily_logs').select('*').eq('member_id', memberId).eq('date', date).maybeSingle();
  if (error) throw error;
  return data;
}
function publicLog(l) { return l ? { id: l.id, date: l.date, task: l.task, status: l.status, submittedAt: l.updated_at, reviewedAt: l.reviewed_at } : null; }

async function approvedLeaveOn(memberId, date) {
  const { data, error } = await db.from('leave_requests').select('id').eq('member_id', memberId).eq('status', 'approved').lte('from_date', date).gte('to_date', date).limit(1);
  if (error) throw error;
  return !!(data && data.length);
}
const ON_LEAVE_MSG = 'You are on approved leave for this date';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dayDiff(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }
function publicLeave(l) { return { id: l.id, fromDate: l.from_date, toDate: l.to_date, leaveType: l.leave_type || 'planned', reason: l.reason, status: l.status, createdAt: l.created_at, reviewedAt: l.reviewed_at }; }

const MARK_LABEL = { absent: 'Absent', compoff: 'Comp-off', sitework: 'Site work' };
async function markOn(memberId, date) {
  try {
    const { data, error } = await db.from('attendance_marks').select('type').eq('member_id', memberId).eq('date', date).maybeSingle();
    if (error) throw error;
    return data?.type || null;
  } catch { return null; }
}
async function logMapFrom(since, memberId) {
  try {
    let q = db.from('daily_logs').select('member_id,date,task,status').gte('date', since);
    if (memberId) q = q.eq('member_id', memberId);
    const { data, error } = await q;
    if (error) throw error;
    const map = {};
    (data || []).forEach(l => { map[l.member_id + '|' + l.date] = l; });
    return map;
  } catch { return {}; }
}
// Status shown in the Report: Present / Absent / Comp-off / Leave.
// A day with no check-in, no mark and no approved leave is Absent automatically (Sundays are off).
function isSunday(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay() === 0; }
function dayStatus({ checkIn, mark, onLeave, date }) {
  if (checkIn) return 'Present';
  if (mark === 'compoff') return 'Comp-off';
  if (mark === 'sitework') return 'Site work';
  if (mark === 'absent') return 'Absent';
  if (onLeave) return 'Leave';
  if (isSunday(date)) return 'Sunday off';
  return date >= ymd() ? 'Waiting response' : 'Absent'; // today is still open: becomes Absent only from the next day
}
async function eidTaken(eid, exceptId) {
  const { data, error } = await db.from('members').select('id,eid');
  if (error) throw error;
  const k = String(eid).trim().toLowerCase();
  return (data || []).some(m => m.id !== exceptId && String(m.eid || '').trim().toLowerCase() === k);
}
async function logActivity(actorType, actorId, action, memberId = null, details = {}) {
  await db.from('activity_logs').insert({ actor_type: actorType, actor_id: actorId, action, member_id: memberId, details });
}


// ---------- Admin who is also a worker ("Link admin member") ----------
// The link is stored in the settings table (key adminMember:<adminId> -> member id), so no SQL migration is needed.
const LINK_PREFIX = 'adminMember:';
async function linkedMemberFor(adminId) {
  const mid = await setting(LINK_PREFIX + adminId, null);
  if (!mid) return null;
  const { data, error } = await db.from('members').select('id,name,eid,dept').eq('id', mid).maybeSingle();
  if (error) throw error;
  return data || null; // member deleted -> link is ignored
}
// req.worker = a logged-in worker, or an admin acting through the member linked to their account.
app.use('/api', async (req, res, next) => {
  req.worker = req.session.worker || null;
  if (!req.worker && req.session.admin && /^\/(worker\/(?!auth|ids)|attendance\/[^/]+\/manual)/.test(req.path)) {
    try { const m = await linkedMemberFor(req.session.admin.id); if (m) req.worker = { id: m.id, name: m.name, eid: m.eid, dept: m.dept }; } catch {}
  }
  next();
});

app.get('/health', (req, res) => res.status(200).json({ ok: true, service: 'jai-maruthi-attendance' }));

app.get('/api/bootstrap', async (req, res) => {
  try {
    const authed = !!(req.session.admin || req.session.worker);
    if (!authed) { // login screens only need to know if an admin exists
      const [companyName, { count: adminCount, error: ae }] = await Promise.all([
        setting('companyName', 'JAI MARUTHI AUTOMATION'),
        db.from('admins').select('*', { count: 'exact', head: true })
      ]);
      if (ae) throw ae;
      return res.json({ date: ymd(), members: [], today: {}, settings: { companyName }, adminCount: adminCount || 0, onLeave: [], marks: {} });
    }
    const [{ data: members, error: me }, today, companyName, { count: adminCount, error: ae }] = await Promise.all([
      db.from('members').select('id,name,eid,dept').order('name'),
      getAttendanceFor(ymd()), setting('companyName', 'JAI MARUTHI AUTOMATION'),
      db.from('admins').select('*', { count: 'exact', head: true })
    ]);
    if (me) throw me; if (ae) throw ae;
    let onLeave = [];
    try { const { data: lv } = await db.from('leave_requests').select('member_id').eq('status', 'approved').lte('from_date', ymd()).gte('to_date', ymd()); onLeave = [...new Set((lv || []).map(x => x.member_id))]; } catch {}
    let marks = {};
    try { const { data: mk } = await db.from('attendance_marks').select('member_id,type').eq('date', ymd()); (mk || []).forEach(x => { marks[x.member_id] = x.type; }); } catch {}
    res.json({ date: ymd(), members: (members || []).map(publicMember), today, settings: { companyName }, adminCount: adminCount || 0, onLeave, marks });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

app.post('/api/admin/auth', async (req, res) => {
  try {
    const { username, password, name, email, mode } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    const { data: existing, error: findErr } = await db.from('admins').select('*').ilike('username', username).maybeSingle();
    if (findErr) throw findErr;
    if (mode === 'setup') {
      const { count } = await db.from('admins').select('*', { count: 'exact', head: true });
      if (count) return res.status(400).json({ error: 'Admin setup is already complete' });
      if (!name || !email || password.length < 8) return res.status(400).json({ error: 'Name, recovery email and an 8+ character password are required' });
      const a = { id: id('admin'), username, name, email, pass_hash: await bcrypt.hash(password, 12), role: 'super', status: 'approved', created_at: new Date().toISOString() };
      const { error } = await db.from('admins').insert(a); if (error) throw error;
      req.session.admin = publicAdmin(a); await logActivity('admin', a.id, 'super_admin_created');
      return res.json({ admin: req.session.admin });
    }
    if (mode === 'signup') {
      if (existing) return res.status(400).json({ error: 'Username already exists' });
      if (!name || !email || password.length < 8) return res.status(400).json({ error: 'Complete all fields; password must be 8+ characters' });
      const a = { id: id('admin'), username, name, email, pass_hash: await bcrypt.hash(password, 12), role: 'admin', status: 'pending', created_at: new Date().toISOString() };
      const { error } = await db.from('admins').insert(a); if (error) throw error;
      await logActivity('system', null, 'admin_signup_requested', null, { username });
      return res.json({ pending: true });
    }
    if (!existing || !(await bcrypt.compare(password, existing.pass_hash))) return res.status(401).json({ error: 'Incorrect username or password' });
    if (existing.status !== 'approved') return res.status(403).json({ error: existing.status === 'pending' ? 'Account is awaiting approval' : 'Admin request was denied' });
    req.session.admin = publicAdmin(existing); res.json({ admin: req.session.admin });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

app.get('/api/admin/requests', requireSuper, async (req, res) => {
  try { const { data, error } = await db.from('admins').select('*').eq('status', 'pending').order('created_at', { ascending: false }); if (error) throw error; res.json({ requests: (data || []).map(publicAdmin) }); }
  catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.patch('/api/admin/requests/:id', requireSuper, async (req, res) => {
  try {
    if (!['approved', 'denied'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    const { data, error } = await db.from('admins').update({ status: req.body.status }).eq('id', req.params.id).eq('status', 'pending').select('id').maybeSingle();
    if (error) throw error; if (!data) return res.status(404).json({ error: 'Request not found' });
    await logActivity('admin', req.session.admin.id, `admin_request_${req.body.status}`, null, { adminId: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

const otpSessions = new Map();
app.post('/api/admin/password/otp', async (req, res) => {
  try {
    const { data: a, error } = await db.from('admins').select('*').eq('username', req.body.username || '').eq('status', 'approved').maybeSingle();
    if (error) throw error;
    if (!a) return res.status(400).json({ error: 'Approved admin account not found' });
    const code = String(crypto.randomInt(100000, 1000000)), token = crypto.randomBytes(24).toString('hex');
    otpSessions.set(token, { adminId: a.id, code, expires: Date.now() + 5 * 60 * 1000, verified: false });
    res.json({ token, message: `Development mode: OTP for ${a.email}`, code: process.env.NODE_ENV === 'production' ? '' : code });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.post('/api/admin/password/verify', (req, res) => {
  const o = otpSessions.get(req.body.token);
  if (!o || Date.now() > o.expires || o.code !== String(req.body.code || '')) return res.status(400).json({ error: 'Invalid or expired OTP' });
  o.verified = true; res.json({ ok: true });
});
app.post('/api/admin/password/reset', async (req, res) => {
  try {
    const o = otpSessions.get(req.body.token);
    if (!o || !o.verified || Date.now() > o.expires) return res.status(400).json({ error: 'OTP verification required' });
    if (!req.body.password || req.body.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const { error } = await db.from('admins').update({ pass_hash: await bcrypt.hash(req.body.password, 12) }).eq('id', o.adminId); if (error) throw error;
    otpSessions.delete(req.body.token); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

app.post('/api/members', requireAdmin, async (req, res) => {
  try {
    const { name, dept, pin } = req.body, eid = String(req.body.eid || '').trim();
    if (!name || !/^\d{4}$/.test(pin || '')) return res.status(400).json({ error: 'Name and a 4-digit PIN are required' });
    if (!eid) return res.status(400).json({ error: 'Worker ID is required (workers log in with it)' });
    if (await eidTaken(eid)) return res.status(400).json({ error: 'That Worker ID is already used by another member' });
    const m = { id: id('member'), name, eid, dept: dept || '—', pin_hash: await bcrypt.hash(pin, 10), created_at: new Date().toISOString() };
    const { error } = await db.from('members').insert(m); if (error) throw error;
    await logActivity('admin', req.session.admin.id, 'member_created', m.id);
    res.json({ member: publicMember(m) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.delete('/api/members/:id', requireAdmin, async (req, res) => {
  try {
    await db.from('attendance').delete().eq('member_id', req.params.id);
    const { data, error } = await db.from('members').delete().eq('id', req.params.id).select('id').maybeSingle(); if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Member not found' });
    await logActivity('admin', req.session.admin.id, 'member_deleted', req.params.id); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
// ---------- Member edit (fix spelling, ID, department, PIN) ----------
app.patch('/api/members/:id', requireSuper, async (req, res) => {
  try {
    const upd = {};
    if (req.body.name !== undefined) { const v = String(req.body.name).trim(); if (!v) return res.status(400).json({ error: 'Name cannot be empty' }); upd.name = v; }
    if (req.body.eid !== undefined) {
      const v = String(req.body.eid).trim();
      if (!v) return res.status(400).json({ error: 'Worker ID cannot be empty' });
      if (await eidTaken(v, req.params.id)) return res.status(400).json({ error: 'That Worker ID is already used by another member' });
      upd.eid = v;
    }
    if (req.body.dept !== undefined) upd.dept = String(req.body.dept).trim() || '—';
    if (req.body.pin !== undefined && req.body.pin !== '') {
      if (!/^\d{4}$/.test(String(req.body.pin))) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
      upd.pin_hash = await bcrypt.hash(String(req.body.pin), 10);
    }
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'Nothing to update' });
    const { data, error } = await db.from('members').update(upd).eq('id', req.params.id).select('id,name,eid,dept').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Member not found' });
    await logActivity('admin', req.session.admin.id, 'member_edited', data.id, { fields: Object.keys(upd).map(k => k === 'pin_hash' ? 'pin' : k) });
    res.json({ member: publicMember(data) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

// ---------- Admin login management (username / password) ----------
const USERNAME_RE = /^[A-Za-z0-9.-]{3,30}$/;
async function usernameTaken(username, exceptId) {
  const { data, error } = await db.from('admins').select('id,username');
  if (error) throw error;
  return (data || []).some(a => a.id !== exceptId && a.username.toLowerCase() === username.toLowerCase());
}
app.patch('/api/admin/account', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, username, newPassword } = req.body;
    const { data: me, error: e0 } = await db.from('admins').select('*').eq('id', req.session.admin.id).maybeSingle();
    if (e0) throw e0;
    if (!me) return res.status(404).json({ error: 'Admin account not found' });
    if (!(await bcrypt.compare(String(currentPassword || ''), me.pass_hash))) return res.status(400).json({ error: 'Current password is incorrect' });
    const upd = {};
    if (username !== undefined && String(username).trim() !== me.username) {
      const u = String(username).trim();
      if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, dot or hyphen' });
      if (await usernameTaken(u, me.id)) return res.status(400).json({ error: 'That username is already taken' });
      upd.username = u;
    }
    if (newPassword) {
      if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
      upd.pass_hash = await bcrypt.hash(String(newPassword), 12);
    }
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'No changes to save' });
    const { data, error } = await db.from('admins').update(upd).eq('id', me.id).select('*').single();
    if (error) throw error;
    req.session.admin = publicAdmin(data);
    await logActivity('admin', me.id, 'admin_account_updated', null, { fields: Object.keys(upd).map(k => k === 'pass_hash' ? 'password' : k) });
    res.json({ admin: req.session.admin });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.get('/api/admin/admins', requireSuper, async (req, res) => {
  try {
    const { data, error } = await db.from('admins').select('*').eq('status', 'approved').order('created_at');
    if (error) throw error;
    res.json({ admins: (data || []).filter(a => a.id !== req.session.admin.id).map(publicAdmin) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.patch('/api/admin/admins/:id', requireSuper, async (req, res) => {
  try {
    if (req.params.id === req.session.admin.id) return res.status(400).json({ error: 'Use your own settings to change your login' });
    const { username, password } = req.body;
    const { data: target, error: e0 } = await db.from('admins').select('*').eq('id', req.params.id).maybeSingle();
    if (e0) throw e0;
    if (!target) return res.status(404).json({ error: 'Admin not found' });
    const upd = {};
    if (username !== undefined && String(username).trim() !== target.username) {
      const u = String(username).trim();
      if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Username must be 3-30 characters: letters, numbers, dot or hyphen' });
      if (await usernameTaken(u, target.id)) return res.status(400).json({ error: 'That username is already taken' });
      upd.username = u;
    }
    if (password) {
      if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      upd.pass_hash = await bcrypt.hash(String(password), 12);
    }
    if (!Object.keys(upd).length) return res.status(400).json({ error: 'No changes to save' });
    const { error } = await db.from('admins').update(upd).eq('id', target.id);
    if (error) throw error;
    await logActivity('admin', req.session.admin.id, 'admin_login_updated', null, { adminId: target.id, fields: Object.keys(upd).map(k => k === 'pass_hash' ? 'password' : k) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

const workerLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many failed attempts. Please try again in 15 minutes.' } });
app.post('/api/worker/auth', workerLoginLimiter, async (req, res) => {
  try {
    const eid = String(req.body.eid || '').trim().toLowerCase(), pin = String(req.body.pin || '');
    if (!eid || !pin) return res.status(400).json({ error: 'Enter your Worker ID and PIN' });
    const { data, error } = await db.from('members').select('id,name,eid,dept,pin_hash'); if (error) throw error;
    let m = null;
    for (const c of (data || []).filter(x => String(x.eid || '').trim().toLowerCase() === eid)) { if (await bcrypt.compare(pin, c.pin_hash)) { m = c; break; } }
    if (!m) return res.status(401).json({ error: 'Incorrect Worker ID or PIN' });
    req.session.worker = { id: m.id, name: m.name, eid: m.eid, dept: m.dept }; res.json({ worker: req.session.worker });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});


// Worker login screen: list of Worker IDs so the worker can pick one (PIN is still required).
app.get('/api/worker/ids', async (req, res) => {
  try {
    const { data, error } = await db.from('members').select('eid').order('eid');
    if (error) throw error;
    const ids = [...new Set((data || []).map(x => String(x.eid || '').trim()).filter(Boolean))];
    res.json({ ids });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

// Admin dashboard > Link admin member
app.get('/api/admin/link-member', requireAdmin, async (req, res) => {
  try {
    const [{ data: members, error }, linked, { data: links }] = await Promise.all([
      db.from('members').select('id,name,eid,dept').order('name'),
      linkedMemberFor(req.session.admin.id),
      db.from('settings').select('key,value').like('key', LINK_PREFIX + '%')
    ]);
    if (error) throw error;
    const takenBy = {}; (links || []).forEach(l => { takenBy[l.value] = l.key.slice(LINK_PREFIX.length); });
    res.json({
      linked: linked ? publicMember(linked) : null,
      members: (members || []).map(m => ({ ...publicMember(m), linkedToOther: !!takenBy[m.id] && takenBy[m.id] !== req.session.admin.id }))
    });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.post('/api/admin/link-member', requireAdmin, async (req, res) => {
  try {
    const memberId = String(req.body.memberId || '');
    const { data: m, error } = await db.from('members').select('id,name,eid,dept').eq('id', memberId).maybeSingle();
    if (error) throw error;
    if (!m) return res.status(404).json({ error: 'Member not found' });
    const { data: links } = await db.from('settings').select('key,value').like('key', LINK_PREFIX + '%');
    if ((links || []).some(l => l.value === m.id && l.key !== LINK_PREFIX + req.session.admin.id)) return res.status(400).json({ error: 'This member is already linked to another admin' });
    await setSetting(LINK_PREFIX + req.session.admin.id, m.id);
    await logActivity('admin', req.session.admin.id, 'admin_linked_member', m.id);
    res.json({ linked: publicMember(m) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.delete('/api/admin/link-member', requireAdmin, async (req, res) => {
  try {
    const { error } = await db.from('settings').delete().eq('key', LINK_PREFIX + req.session.admin.id);
    if (error) throw error;
    await logActivity('admin', req.session.admin.id, 'admin_unlinked_member');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

async function adminAttendance(req, res, type) {
  try {
    const date = ymd(), r = await getOneAttendance(req.params.id, date);
    if (type === 'checkIn' && r?.check_in) return res.status(400).json({ error: 'Already checked in' });
    if (type === 'checkOut' && !r?.check_in) return res.status(400).json({ error: 'Check in first' });
    if (type === 'checkOut' && r?.check_out) return res.status(400).json({ error: 'Already checked out' });
    if (type === 'checkIn') { try { await db.from('attendance_marks').delete().eq('member_id', req.params.id).eq('date', date); } catch {} }
    await setAttendance(req.params.id, date, type, nowHM(), true); await logActivity('admin', req.session.admin.id, type === 'checkIn' ? 'admin_check_in' : 'admin_check_out', req.params.id); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
}
async function workerAttendance(req, res, type) {
  try {
    const date = ymd(), r = await getOneAttendance(req.worker.id, date);
    if (type === 'checkIn' && r?.check_in) return res.status(400).json({ error: 'Already checked in' });
    if (type === 'checkIn' && await approvedLeaveOn(req.worker.id, date)) return res.status(403).json({ error: ON_LEAVE_MSG });
    if (type === 'checkIn') { const mk = await markOn(req.worker.id, date); if (mk && mk !== 'sitework') return res.status(403).json({ error: `You are marked ${MARK_LABEL[mk]} today. Contact your admin.` }); }
    if (type === 'checkOut' && !r?.check_in) return res.status(400).json({ error: 'Check in first' });
    if (type === 'checkOut' && r?.check_out) return res.status(400).json({ error: 'Already checked out' });
    await setAttendance(req.worker.id, date, type, nowHM(), false); await logActivity('worker', req.worker.id, type === 'checkIn' ? 'worker_check_in' : 'worker_check_out', req.worker.id); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
}
app.post('/api/attendance/:id/check-in', requireAdmin, (req, res) => adminAttendance(req, res, 'checkIn'));
app.post('/api/attendance/:id/check-out', requireAdmin, (req, res) => adminAttendance(req, res, 'checkOut'));
app.post('/api/worker/check-in', requireWorker, (req, res) => workerAttendance(req, res, 'checkIn'));
// Worker check-out sends the daily log to the admins together with the check-out.
// The day is only counted as present once an admin approves the log.
app.post('/api/worker/check-out', requireWorker, async (req, res) => {
  try {
    const memberId = req.worker.id, date = ymd();
    const r = await getOneAttendance(memberId, date);
    if (!r?.check_in) return res.status(400).json({ error: 'Check in first' });
    if (r.check_out) return res.status(400).json({ error: 'Already checked out' });
    const existing = await getTodayLog(memberId, date);
    const approved = existing?.status === 'approved';
    let log = existing;
    if (!approved) {
      const task = String(req.body?.task || '').trim() || existing?.task || '';
      if (task.length < 3) return res.status(400).json({ error: 'Write your daily log before checking out' });
      if (task.length > 1000) return res.status(400).json({ error: 'Daily log is too long (max 1000 characters)' });
      const { data, error } = await db.from('daily_logs').upsert({ member_id: memberId, date, task, status: 'pending', reviewed_by: null, reviewed_at: null, updated_at: new Date().toISOString() }, { onConflict: 'member_id,date' }).select('*').single();
      if (error) throw error;
      log = data;
      await logActivity('worker', memberId, 'daily_log_submitted', memberId, { date });
    }
    await setAttendance(memberId, date, 'checkOut', nowHM(), approved);
    await logActivity('worker', memberId, 'worker_check_out', memberId);
    res.json({ ok: true, pendingApproval: !approved, log: publicLog(log) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

app.post('/api/attendance/:id/manual', requireWorker, async (req, res) => {
  try {
    if (req.worker.id !== req.params.id) return res.status(403).json({ error: 'You can edit only your attendance' });
    const { type, date, time } = req.body;
    if (!['checkIn', 'checkOut'].includes(type) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Invalid date or time' });
    const { data: m, error } = await db.from('members').select('*').eq('id', req.params.id).maybeSingle(); if (error) throw error;
    if (!m) return res.status(404).json({ error: 'Member not found' });
    if (await approvedLeaveOn(m.id, date)) return res.status(403).json({ error: ON_LEAVE_MSG });
    { const mk = await markOn(m.id, date); if (mk && mk !== 'sitework') return res.status(403).json({ error: `You are marked ${MARK_LABEL[mk]} on this date. Contact your admin.` }); }
    await setAttendance(m.id, date, type, time);
    await logActivity('worker', m.id, 'manual_attendance_edit', m.id, { type, date, time }); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

// ---------- Daily log (worker request -> admin approval -> unlocks check-out) ----------
app.get('/api/worker/daily-log', requireWorker, async (req, res) => {
  try { res.json({ log: publicLog(await getTodayLog(req.worker.id, ymd())) }); }
  catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.post('/api/worker/daily-log', requireWorker, async (req, res) => {
  try {
    const task = String(req.body.task || '').trim();
    if (task.length < 3) return res.status(400).json({ error: 'Please describe your task (at least 3 characters)' });
    if (task.length > 1000) return res.status(400).json({ error: 'Daily log is too long (max 1000 characters)' });
    const date = ymd(), memberId = req.worker.id;
    const att = await getOneAttendance(memberId, date);
    if (!att?.check_in) return res.status(400).json({ error: 'Check in first, then send your daily log' });
    const existing = await getTodayLog(memberId, date);
    if (existing?.status === 'approved') return res.status(400).json({ error: 'Today\'s daily log is already approved' });
    if (existing?.status === 'pending') return res.status(400).json({ error: 'Your request is already waiting for admin approval' });
    const { data, error } = await db.from('daily_logs').upsert({ member_id: memberId, date, task, status: 'pending', reviewed_by: null, reviewed_at: null, updated_at: new Date().toISOString() }, { onConflict: 'member_id,date' }).select('*').single();
    if (error) throw error;
    await logActivity('worker', memberId, 'daily_log_submitted', memberId, { date });
    res.json({ log: publicLog(data) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.get('/api/admin/daily-logs', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || 30, 10), 1), 365);
    const since = ymd(new Date(Date.now() - days * 86400000));
    const { data, error } = await db.from('daily_logs').select('id,date,task,status,updated_at,reviewed_at,members(name,eid,dept)').gte('date', since).order('updated_at', { ascending: false });
    if (error) throw error;
    const rows = (data || []).map(x => ({ id: x.id, date: x.date, task: x.task, status: x.status, submittedAt: x.updated_at, reviewedAt: x.reviewed_at, name: x.members?.name, eid: x.members?.eid, dept: x.members?.dept }));
    res.json({ rows, pendingCount: rows.filter(r => r.status === 'pending').length });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.patch('/api/admin/daily-logs/:id', requireAdmin, async (req, res) => {
  try {
    if (!['approved', 'denied'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    const { data, error } = await db.from('daily_logs').update({ status: req.body.status, reviewed_by: req.session.admin.id, reviewed_at: new Date().toISOString() }).eq('id', req.params.id).eq('status', 'pending').select('id,member_id,date').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pending request not found (already reviewed?)' });
    if (req.body.status === 'approved') {
      const { error: ae } = await db.from('attendance').update({ counted: true }).eq('member_id', data.member_id).eq('date', data.date);
      if (ae) throw ae;
    }
    await logActivity('admin', req.session.admin.id, `daily_log_${req.body.status}`, data.member_id, { logId: data.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

// ---------- Leave (worker request -> admin approval) ----------
app.get('/api/worker/leaves', requireWorker, async (req, res) => {
  try {
    const { data, error } = await db.from('leave_requests').select('*').eq('member_id', req.worker.id).order('created_at', { ascending: false }).limit(30);
    if (error) throw error;
    res.json({ leaves: (data || []).map(publicLeave), onLeaveToday: await approvedLeaveOn(req.worker.id, ymd()), markToday: await markOn(req.worker.id, ymd()) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.post('/api/worker/leaves', requireWorker, async (req, res) => {
  try {
    const { fromDate, toDate } = req.body, reason = String(req.body.reason || '').trim();
    const leaveType = req.body.leaveType === undefined ? 'planned' : String(req.body.leaveType);
    if (!['planned', 'emergency'].includes(leaveType)) return res.status(400).json({ error: 'Choose Planned leave or Emergency leave' });
    if (!DATE_RE.test(fromDate || '') || !DATE_RE.test(toDate || '')) return res.status(400).json({ error: 'Choose a valid from and to date' });
    if (fromDate < ymd()) return res.status(400).json({ error: 'Leave cannot start in the past' });
    // Planned leave must be submitted at least one day before it starts. Emergency leave may start today.
    if (leaveType === 'planned' && fromDate < ymd(new Date(Date.now() + 86400000))) return res.status(400).json({ error: 'Planned leave must be submitted at least one day before the leave starts. For an urgent leave today, choose Emergency leave.' });
    if (toDate < fromDate) return res.status(400).json({ error: 'The end date cannot be before the start date' });
    if (dayDiff(fromDate, toDate) > 59) return res.status(400).json({ error: 'A single leave request can cover at most 60 days' });
    if (reason.length < 3) return res.status(400).json({ error: 'Please enter a reason for your leave' });
    if (reason.length > 500) return res.status(400).json({ error: 'Reason is too long (max 500 characters)' });
    const { data: clash, error: ce } = await db.from('leave_requests').select('id').eq('member_id', req.worker.id).in('status', ['pending', 'approved']).lte('from_date', toDate).gte('to_date', fromDate).limit(1);
    if (ce) throw ce;
    if (clash && clash.length) return res.status(400).json({ error: 'You already have a pending or approved leave overlapping these dates' });
    const { data, error } = await db.from('leave_requests').insert({ member_id: req.worker.id, from_date: fromDate, to_date: toDate, leave_type: leaveType, reason }).select('*').single();
    if (error) throw error;
    await logActivity('worker', req.worker.id, 'leave_requested', req.worker.id, { fromDate, toDate, leaveType });
    res.json({ leave: publicLeave(data) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.delete('/api/worker/leaves/:id', requireWorker, async (req, res) => {
  try {
    const { data, error } = await db.from('leave_requests').delete().eq('id', req.params.id).eq('member_id', req.worker.id).eq('status', 'pending').select('id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pending request not found' });
    await logActivity('worker', req.worker.id, 'leave_cancelled', req.worker.id, {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.get('/api/admin/leaves', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await db.from('leave_requests').select('id,from_date,to_date,leave_type,reason,status,created_at,reviewed_at,members(name,eid,dept)').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    const rows = (data || []).map(x => ({ ...publicLeave(x), name: x.members?.name, eid: x.members?.eid, dept: x.members?.dept }));
    res.json({ rows, pendingCount: rows.filter(r => r.status === 'pending').length });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.patch('/api/admin/leaves/:id', requireAdmin, async (req, res) => {
  try {
    if (!['approved', 'denied'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
    const { data, error } = await db.from('leave_requests').update({ status: req.body.status, reviewed_by: req.session.admin.id, reviewed_at: new Date().toISOString() }).eq('id', req.params.id).eq('status', 'pending').select('id,member_id').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Pending request not found (already reviewed?)' });
    await logActivity('admin', req.session.admin.id, `leave_${req.body.status}`, data.member_id, { leaveId: data.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

// ---------- Absent / Comp-off marks (admin) ----------
// ---------- Member calendar (attendance + OT + comp-off/absent + leave for one month) ----------
app.get('/api/admin/members/:id/calendar', requireAdmin, async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : ymd().slice(0, 7);
    const [y, mo] = month.split('-').map(Number);
    if (mo < 1 || mo > 12) return res.status(400).json({ error: 'Invalid month' });
    const first = month + '-01', last = month + '-' + String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0');
    const memberId = req.params.id;
    const { data: m, error: me } = await db.from('members').select('id,name,eid,dept,created_at').eq('id', memberId).maybeSingle();
    if (me) throw me;
    if (!m) return res.status(404).json({ error: 'Member not found' });
    const safe = async (q) => { try { const { data, error } = await q; if (error) throw error; return data || []; } catch { return []; } };
    const [att, marks, leaves, logs] = await Promise.all([
      safe(db.from('attendance').select('date,check_in,check_out,counted').eq('member_id', memberId).gte('date', first).lte('date', last)),
      safe(db.from('attendance_marks').select('date,type,note,sub_type').eq('member_id', memberId).gte('date', first).lte('date', last)).then(r => r.length ? r : safe(db.from('attendance_marks').select('date,type,note').eq('member_id', memberId).gte('date', first).lte('date', last))),
      safe(db.from('leave_requests').select('from_date,to_date,leave_type,reason,status').eq('member_id', memberId).eq('status', 'approved').lte('from_date', last).gte('to_date', first)),
      safe(db.from('daily_logs').select('date,task,status').eq('member_id', memberId).gte('date', first).lte('date', last))
    ]);
    res.json({
      month, today: ymd(), member: { id: m.id, name: m.name, eid: m.eid, dept: m.dept, createdAt: m.created_at ? ymd(new Date(m.created_at)) : '' },
      attendance: att.map(a => ({ date: a.date, checkIn: a.check_in, checkOut: a.check_out, counted: a.counted !== false })),
      marks: marks.map(k => ({ date: k.date, type: k.type, note: k.note || '', subType: k.sub_type || '' })),
      leaves: leaves.map(l => ({ fromDate: l.from_date, toDate: l.to_date, leaveType: l.leave_type || 'planned', reason: l.reason })),
      logs: logs.map(l => ({ date: l.date, status: l.status, task: l.status === 'denied' ? '' : l.task }))
    });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

// ---------- Member-wise attendance log (Present / Absent / Planned leave / Emergency leave / Comp-off) ----------
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
app.get('/api/admin/attendance-log', requireAdmin, async (req, res) => {
  try {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : ymd().slice(0, 7);
    const [y, mo] = month.split('-').map(Number);
    if (mo < 1 || mo > 12) return res.status(400).json({ error: 'Invalid month' });
    const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const first = month + '-01', last = month + '-' + String(daysIn).padStart(2, '0'), today = ymd();
    const { data: members, error: me } = await db.from('members').select('id,name,eid,dept,created_at').order('name');
    if (me) throw me;
    const [att, marks, leaves] = await Promise.all([
      fetchAll(() => db.from('attendance').select('member_id,date,check_in,counted').gte('date', first).lte('date', last).order('id')),
      fetchAll(() => db.from('attendance_marks').select('member_id,date,type').gte('date', first).lte('date', last).order('id')).catch(() => []),
      fetchAll(() => db.from('leave_requests').select('member_id,from_date,to_date,leave_type').eq('status', 'approved').lte('from_date', last).gte('to_date', first).order('id'))
    ]);
    const attBy = {}, markBy = {}, leaveBy = {};
    att.forEach(a => { attBy[a.member_id + '|' + a.date] = a; });
    marks.forEach(k => { markBy[k.member_id + '|' + k.date] = k; });
    leaves.forEach(l => { (leaveBy[l.member_id] = leaveBy[l.member_id] || []).push(l); });
    const rows = (members || []).map(m => {
      const days = [], totals = { P: 0, A: 0, PL: 0, EL: 0, CO: 0, SW: 0, W: 0 };
      const since = m.created_at ? ymd(new Date(m.created_at)) : '0000-00-00'; // no auto-absent before the member was added
      for (let d = 1; d <= daysIn; d++) {
        const ds = month + '-' + String(d).padStart(2, '0'), dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
        const a = attBy[m.id + '|' + ds], mk = markBy[m.id + '|' + ds];
        const lv = (leaveBy[m.id] || []).find(l => l.from_date <= ds && l.to_date >= ds);
        let c = '';
        if (a?.check_in && a.counted !== false) c = 'P';
        else if (mk) c = mk.type === 'absent' ? 'A' : mk.type === 'sitework' ? 'SW' : 'CO';
        else if (lv) c = lv.leave_type === 'emergency' ? 'EL' : 'PL';
        else if (a?.check_in) c = 'W'; // worker's own entry still waiting for admin approval
        else if (ds < today && ds >= since && dow !== 0) c = 'A'; // no check-in on a past working day (Mon-Sat) = Absent automatically
        else if (ds === today && ds >= since && dow !== 0) c = 'WR'; // today, nothing yet = waiting for response (turns Absent tomorrow)
        if (c && c !== 'WR') totals[c]++;
        days.push(c);
      }
      return { id: m.id, name: m.name, eid: m.eid, dept: m.dept, days, totals };
    });
    res.json({ month, daysIn, today, members: rows });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

app.get('/api/admin/marks', requireAdmin, async (req, res) => {
  try {
    const cols = (c) => { let q = db.from('attendance_marks').select(c).order('date', { ascending: false }).limit(60); if (req.query.memberId) q = q.eq('member_id', String(req.query.memberId)); return q; };
    let { data, error } = await cols('id,member_id,date,type,note,sub_type,created_at');
    if (error) ({ data, error } = await cols('id,member_id,date,type,note,created_at'));
    if (error) throw error;
    res.json({ marks: (data || []).map(x => ({ id: x.id, memberId: x.member_id, date: x.date, type: x.type, note: x.note || '', subType: x.sub_type || '' })) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.post('/api/admin/marks', requireAdmin, async (req, res) => {
  try {
    const { memberId, date, type } = req.body, note = String(req.body.note || '').trim().slice(0, 200);
    const subType = type === 'absent' && ['public', 'annual'].includes(req.body.subType) ? req.body.subType : null;
    if (!['absent', 'compoff', 'sitework'].includes(type)) return res.status(400).json({ error: 'Choose Absent, Comp-off or Site work' });
    if (!DATE_RE.test(date || '')) return res.status(400).json({ error: 'Choose a valid date' });
    const { data: m, error: me } = await db.from('members').select('id').eq('id', memberId).maybeSingle();
    if (me) throw me;
    if (!m) return res.status(404).json({ error: 'Member not found' });
    const att = await getOneAttendance(memberId, date);
    if (att?.check_in) return res.status(400).json({ error: 'This worker already has attendance on that date' });
    const row = { member_id: memberId, date, type, note, marked_by: req.session.admin.id };
    let { error } = await db.from('attendance_marks').upsert({ ...row, sub_type: subType }, { onConflict: 'member_id,date' });
    if (error && /sub_type/i.test(error.message || '')) ({ error } = await db.from('attendance_marks').upsert(row, { onConflict: 'member_id,date' })); // migration not run yet
    if (error) throw error;
    await logActivity('admin', req.session.admin.id, type === 'absent' ? 'marked_absent' : type === 'sitework' ? 'marked_sitework' : 'marked_compoff', memberId, { date });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.delete('/api/admin/marks/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await db.from('attendance_marks').delete().eq('id', req.params.id).select('member_id,date').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Mark not found' });
    await logActivity('admin', req.session.admin.id, 'mark_removed', data.member_id, { date: data.date });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});

app.get('/api/report/today', requireAdmin, async (req, res) => {
  try {
    const date = ymd();
    const safe = async (q) => { try { const { data, error } = await q; if (error) throw error; return data || []; } catch { return []; } };
    const [logs, { data: members, error }, att, marks, leaves] = await Promise.all([
      logMapFrom(date),
      db.from('members').select('id,name,eid,dept').order('name'),
      safe(db.from('attendance').select('member_id,check_in,check_out,counted').eq('date', date)),
      safe(db.from('attendance_marks').select('member_id,type').eq('date', date)),
      safe(db.from('leave_requests').select('member_id').eq('status', 'approved').lte('from_date', date).gte('to_date', date))
    ]);
    if (error) throw error;
    const attBy = {}, markBy = {}, leaveSet = new Set(leaves.map(x => x.member_id));
    att.forEach(a => { attBy[a.member_id] = a; }); marks.forEach(k => { markBy[k.member_id] = k.type; });
    const rows = (members || []).map(m => {
      const a = attBy[m.id] || {}, lg = logs[m.id + '|' + date];
      return { name: m.name, eid: m.eid, dept: m.dept, checkIn: a.check_in || null, checkOut: a.check_out || null, counted: a.counted !== false, status: dayStatus({ checkIn: a.check_in, mark: markBy[m.id], onLeave: leaveSet.has(m.id), date }), task: lg?.status === 'denied' ? '' : (lg?.task || ''), logStatus: lg?.status || '' };
    });
    res.json({ date, rows });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.get('/api/activity', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || 30, 10), 1), 365);
    const since = ymd(new Date(Date.now() - days * 86400000));
    const logs = await logMapFrom(since);
    const { data, error } = await db.from('attendance').select('member_id,date,check_in,check_out,counted,members(name,eid,dept)').gte('date', since).order('date', { ascending: false }); if (error) throw error;
    const rows = (data || []).map(x => { const lg = logs[x.member_id + '|' + x.date]; return { date: x.date, name: x.members?.name, eid: x.members?.eid, dept: x.members?.dept, checkIn: x.check_in, checkOut: x.check_out, counted: x.counted !== false, status: status(x.check_in, x.check_out), task: lg?.status === 'denied' ? '' : (lg?.task || ''), logStatus: lg?.status || '' }; }); res.json({ rows });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.get('/api/worker/history', requireWorker, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || 14, 10), 1), 365);
    const since = ymd(new Date(Date.now() - days * 86400000));
    const { data, error } = await db.from('attendance').select('date,check_in,check_out,counted').eq('member_id', req.worker.id).gte('date', since).order('date', { ascending: false }); if (error) throw error;
    const logs = await logMapFrom(since, req.worker.id);
    res.json({ rows: (data || []).map(x => { const lg = logs[req.worker.id + '|' + x.date]; return { date: x.date, checkIn: x.check_in, checkOut: x.check_out, counted: x.counted !== false, task: lg?.status === 'denied' ? '' : (lg?.task || ''), logStatus: lg?.status || '' }; }) });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
// ---------- Settings > All data (read-only browse + CSV, loaded one table at a time) ----------
const ALL_DATA = {
  members:    () => db.from('members').select('id,name,eid,dept,created_at').order('name').order('id'),
  attendance: (since) => { let q = db.from('attendance').select('date,check_in,check_out,counted,members(name,eid,dept)'); if (since) q = q.gte('date', since); return q.order('date', { ascending: false }).order('id'); },
  leaves:     (since) => { let q = db.from('leave_requests').select('from_date,to_date,leave_type,reason,status,created_at,reviewed_at,members(name,eid,dept)'); if (since) q = q.gte('to_date', since); return q.order('from_date', { ascending: false }).order('id'); },
  logs:       (since) => { let q = db.from('daily_logs').select('date,task,status,updated_at,reviewed_at,members(name,eid,dept)'); if (since) q = q.gte('date', since); return q.order('date', { ascending: false }).order('id'); },
  marks:      (since) => { let q = db.from('attendance_marks').select('date,type,sub_type,note,members(name,eid,dept)'); if (since) q = q.gte('date', since); return q.order('date', { ascending: false }).order('id'); }
};
app.get('/api/admin/data/:kind', requireAdmin, async (req, res) => {
  try {
    const build = ALL_DATA[req.params.kind];
    if (!build) return res.status(404).json({ error: 'Unknown data set' });
    const d = String(req.query.days || '90');
    const since = d === 'all' ? null : ymd(new Date(Date.now() - Math.min(Math.max(parseInt(d, 10) || 90, 1), 3650) * 86400000));
    let rows;
    try { rows = await fetchAll(() => build(since)); }
    catch (e) { if (req.params.kind === 'marks' && /sub_type/i.test(e.message || '')) rows = await fetchAll(() => { let q = db.from('attendance_marks').select('date,type,note,members(name,eid,dept)'); if (since) q = q.gte('date', since); return q.order('date', { ascending: false }).order('id'); }); else throw e; }
    if (rows.length > 20000) rows = rows.slice(0, 20000);
    res.json({ kind: req.params.kind, since, rows });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.patch('/api/settings', requireSuper, async (req, res) => {
  try {
    const { companyName } = req.body;
    if (companyName !== undefined) {
      if (typeof companyName !== 'string' || !companyName.trim()) return res.status(400).json({ error: 'Company name cannot be empty' });
      await setSetting('companyName', companyName.trim());
    }
    res.json({ settings: { companyName: await setting('companyName', 'JAI MARUTHI AUTOMATION') } });
  } catch (e) { res.status(500).json({ error: errText(e) }); }
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(__dirname, 'public', 'index.html')); next(); });

ensureDefaults().then(() => app.listen(PORT, () => console.log(`JAI MARUTHI AUTOMATION Attendance running on http://localhost:${PORT}`))).catch(e => { console.error('Supabase initialization failed:', e); process.exit(1); });