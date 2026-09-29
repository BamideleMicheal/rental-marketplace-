const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const email = require('./email');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-local-secret';
const COUNTRY = 'Nigeria';

if (!DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Set it before starting Rental Marketplace.');
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

const locations = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'locations.json'), 'utf8')
);

app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    cb(allowed.has(file.mimetype) ? null : new Error('Only JPG, PNG, and WebP images are allowed.'), allowed.has(file.mimetype));
  }
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function safeUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

function tokenFor(user) {
  const payload = Buffer.from(JSON.stringify({
    id: user.id, role: user.role, exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const [payload, sig] = header.slice(7).split('.');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error('bad signature');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) throw new Error('expired');
    req.user = { id: Number(data.id), role: data.role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired authentication token.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this action.' });
    next();
  };
}

function validState(state) {
  return locations.states.includes(state);
}

function validDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}


const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYMENT_PROVIDER = PAYSTACK_SECRET_KEY ? 'paystack' : 'manual';

function notify(promise) {
  Promise.resolve(promise).catch(err => console.error('Email notification failed:', err.message));
}

async function paystack(pathname, body, method = 'POST') {
  if (!PAYSTACK_SECRET_KEY) throw new Error('PAYSTACK_SECRET_KEY is not configured.');
  const response = await fetch(`https://api.paystack.co${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status === false) {
    throw new Error(data.message || 'Payment provider request failed.');
  }
  return data;
}

function verifyPaystackSignature(req) {
  const signature = req.get('x-paystack-signature') || '';
  if (!PAYSTACK_SECRET_KEY || !signature) return false;
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(req.body))
    .digest('hex');
  return signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, app: 'Rental Marketplace', database: 'connected' });
  } catch (e) {
    res.status(503).json({ ok: false, app: 'Rental Marketplace', database: 'unavailable', error: e.message });
  }
});

app.get('/api/locations', (_req, res) => res.json(locations));

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role = 'member' } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const safeRole = role === 'lender' ? 'lender' : 'member';
  try {
    const { hash, salt } = hashPassword(String(password));
    const result = await pool.query(
      `INSERT INTO users(name,email,password_hash,password_salt,role)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,name,email,role`,
      [String(name).trim(), String(email).trim().toLowerCase(), hash, salt, safeRole]
    );
    const user = safeUser(result.rows[0]);
    notify(email.welcome(user));
    res.status(201).json({ user, token: tokenFor(user) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An account with that email already exists.' });
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '').trim().toLowerCase()]);
    if (!result.rowCount) return res.status(401).json({ error: 'Invalid email or password.' });
    const row = result.rows[0];
    const { hash } = hashPassword(String(password || ''), row.password_salt);
    if (hash !== row.password_hash) return res.status(401).json({ error: 'Invalid email or password.' });
    const user = safeUser(row);
    res.json({ user, token: tokenFor(user) });
  } catch {
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const result = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [req.user.id]);
  if (!result.rowCount) return res.status(401).json({ error: 'User no longer exists.' });
  res.json({ user: result.rows[0] });
});

app.get('/api/listings', async (req, res) => {
  const { state, city, area, category, q, startDate, endDate } = req.query;
  const params = [COUNTRY];
  const where = [`l.country=$1`, `l.status='active'`];
  if (state) { params.push(state); where.push(`l.state=$${params.length}`); }
  if (city) { params.push(city); where.push(`l.city=$${params.length}`); }
  if (area) { params.push(area); where.push(`l.area=$${params.length}`); }
  if (category && category !== 'All') { params.push(category); where.push(`l.category=$${params.length}`); }
  if (q) {
    params.push(`%${String(q).toLowerCase()}%`);
    where.push(`LOWER(l.name || ' ' || l.category || ' ' || l.state || ' ' || l.city || ' ' || l.area) LIKE $${params.length}`);
  }
  if (startDate && endDate && validDate(startDate) && validDate(endDate)) {
    params.push(startDate, endDate);
    where.push(`NOT EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.listing_id=l.id
      AND b.status IN ('pending','confirmed')
      AND daterange(b.start_date,b.end_date,'[)') && daterange($${params.length-1}::date,$${params.length}::date,'[)')
    )`);
  }
  const result = await pool.query(
    `SELECT l.id,l.name,l.category,l.price,l.deposit,l.country,l.state,l.city,l.area,l.image,l.description,l.owner_id,
            u.name AS owner_name,l.status,l.created_at
       FROM listings l JOIN users u ON u.id=l.owner_id
      WHERE ${where.join(' AND ')}
      ORDER BY l.created_at DESC`, params);
  res.json(result.rows);
});

app.post('/api/listings', auth, requireRole('lender','admin'), async (req, res) => {
  const { name, category, price, deposit = 0, country = COUNTRY, state, city, area, image, description } = req.body || {};
  if (country !== COUNTRY) return res.status(400).json({ error: 'Country must be Nigeria.' });
  if (!validState(state)) return res.status(400).json({ error: 'Select a valid Nigerian state or FCT Abuja.' });
  if (!name || !category || !city || !area || !image || !description || Number(price) < 0) {
    return res.status(400).json({ error: 'Complete all listing fields.' });
  }
  const result = await pool.query(
    `INSERT INTO listings(name,category,price,deposit,country,state,city,area,image,description,owner_id,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [name,category,Number(price),Number(deposit),COUNTRY,state,city,area,image,description,req.user.id,
     req.user.role === 'admin' ? 'active' : 'pending-review']
  );
  res.status(201).json(result.rows[0]);
});

app.post('/api/uploads', auth, requireRole('lender','admin'), (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Image is required.' });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

app.get('/api/bookings', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT b.*,l.name AS item,l.state,l.city,l.area,l.price,u.name AS lender_name
       FROM bookings b
       JOIN listings l ON l.id=b.listing_id
       JOIN users u ON u.id=l.owner_id
      WHERE b.renter_id=$1 OR l.owner_id=$1
      ORDER BY b.created_at DESC`, [req.user.id]);
  res.json(result.rows);
});

app.post('/api/bookings', auth, async (req, res) => {
  const { listingId, startDate, endDate } = req.body || {};
  if (!listingId || !validDate(startDate) || !validDate(endDate) || startDate >= endDate) {
    return res.status(400).json({ error: 'Choose a valid start and end date.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const listing = await client.query(
      `SELECT * FROM listings WHERE id=$1 AND status='active' FOR SHARE`, [listingId]);
    if (!listing.rowCount) throw Object.assign(new Error('Listing is unavailable.'), { status: 404 });
    if (Number(listing.rows[0].owner_id) === Number(req.user.id)) {
      throw Object.assign(new Error('You cannot book your own listing.'), { status: 400 });
    }
    const price = Number(listing.rows[0].price);
    const days = Math.max(1, Math.ceil((new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`)) / 86400000));
    const total = price * days;
    const booking = await client.query(
      `INSERT INTO bookings(listing_id,renter_id,start_date,end_date,total,status)
       VALUES($1,$2,$3,$4,$5,'pending') RETURNING *`,
      [listingId, req.user.id, startDate, endDate, total]);
    const contacts = await client.query(
      `SELECT l.name AS item, renter.name AS renter_name, renter.email AS renter_email,
              lender.name AS lender_name, lender.email AS lender_email
         FROM listings l
         JOIN users renter ON renter.id=$2
         JOIN users lender ON lender.id=l.owner_id
        WHERE l.id=$1`, [listingId, req.user.id]);
    await client.query('COMMIT');
    if (contacts.rowCount) {
      const x = contacts.rows[0];
      notify(email.bookingCreated({to:x.renter_email,name:x.renter_name,item:x.item,startDate,endDate,total}));
      notify(email.bookingReceived({to:x.lender_email,name:x.lender_name,item:x.item,startDate,endDate,total}));
    }
    res.status(201).json(booking.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23P01') return res.status(409).json({ error: 'Those dates are already booked.' });
    res.status(e.status || 500).json({ error: e.message || 'Booking failed.' });
  } finally {
    client.release();
  }
});

app.get('/api/lender/payouts', auth, requireRole('lender','admin'), async (req, res) => {
  const result = await pool.query(
    `SELECT p.*,l.name AS listing_name FROM payouts p
     LEFT JOIN bookings b ON b.id=p.booking_id
     LEFT JOIN listings l ON l.id=b.listing_id
     WHERE p.lender_id=$1 ORDER BY p.created_at DESC`, [req.user.id]);
  res.json(result.rows);
});

app.post('/api/disputes', auth, async (req, res) => {
  const { bookingId, reason, details = '' } = req.body || {};
  if (!bookingId || !reason) return res.status(400).json({ error: 'Booking and reason are required.' });
  const result = await pool.query(
    `INSERT INTO disputes(booking_id,reporter_id,listing_id,reason,details)
     SELECT b.id,$2,b.listing_id,$3,$4 FROM bookings b
     WHERE b.id=$1 AND (b.renter_id=$2 OR EXISTS(
       SELECT 1 FROM listings l WHERE l.id=b.listing_id AND l.owner_id=$2
     )) RETURNING *`,
    [bookingId, req.user.id, reason, details]);
  if (!result.rowCount) return res.status(404).json({ error: 'Booking not found or not accessible.' });
  res.status(201).json(result.rows[0]);
});

app.get('/api/admin/disputes', auth, requireRole('admin'), async (_req, res) => {
  const result = await pool.query(
    `SELECT d.*,b.renter_id,l.name AS listing_name,u.name AS reporter_name
       FROM disputes d
       JOIN bookings b ON b.id=d.booking_id
       JOIN listings l ON l.id=b.listing_id
       JOIN users u ON u.id=d.reporter_id
      ORDER BY d.created_at DESC`);
  res.json(result.rows);
});

app.post('/api/admin/disputes/:id/resolve', auth, requireRole('admin'), async (req, res) => {
  const { resolution, status = 'resolved' } = req.body || {};
  const result = await pool.query(
    `UPDATE disputes SET status=$1,resolution=$2,resolved_by=$3,resolved_at=NOW()
     WHERE id=$4 RETURNING *`,
    [status, resolution || '', req.user.id, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Dispute not found.' });
  res.json(result.rows[0]);
});

app.post('/api/escrow/authorize', auth, async (req, res) => {
  const { bookingId } = req.body || {};
  const booking = await pool.query(
    `SELECT b.*, l.name AS listing_name, u.email AS renter_email
       FROM bookings b
       JOIN listings l ON l.id=b.listing_id
       JOIN users u ON u.id=b.renter_id
      WHERE b.id=$1 AND b.renter_id=$2`, [bookingId, req.user.id]);
  if (!booking.rowCount) return res.status(404).json({ error: 'Booking not found.' });

  const b = booking.rows[0];
  const existing = await pool.query(
    `SELECT * FROM escrow_transactions WHERE booking_id=$1
     ORDER BY created_at DESC LIMIT 1`, [b.id]);
  if (existing.rowCount && ['funded','release_pending','released'].includes(existing.rows[0].status)) {
    return res.json({ escrow: existing.rows[0], payment: null });
  }

  const reference = `RM-${crypto.randomUUID()}`;
  const inserted = await pool.query(
    `INSERT INTO escrow_transactions(reference,booking_id,user_id,amount,provider,status)
     VALUES($1,$2,$3,$4,$5,'payment_pending') RETURNING *`,
    [reference,b.id,req.user.id,b.total,PAYMENT_PROVIDER]);

  const escrow = inserted.rows[0];

  // Local development mode: create the escrow record without pretending that money moved.
  if (!PAYSTACK_SECRET_KEY) {
    return res.status(201).json({
      escrow,
      payment: null,
      mode: 'manual',
      message: 'Escrow created in local/manual mode. Configure PAYSTACK_SECRET_KEY for real payment checkout.'
    });
  }

  try {
    const payment = await paystack('/transaction/initialize', {
      email: b.renter_email,
      amount: Math.round(Number(b.total) * 100),
      currency: 'NGN',
      reference,
      metadata: { booking_id: String(b.id), escrow_id: String(escrow.id) }
    });

    await pool.query(
      `UPDATE escrow_transactions
          SET provider_reference=$1
        WHERE id=$2`, [payment.data.reference, escrow.id]);

    res.status(201).json({
      escrow: { ...escrow, provider_reference: payment.data.reference },
      payment: {
        authorization_url: payment.data.authorization_url,
        access_code: payment.data.access_code,
        reference: payment.data.reference
      },
      mode: 'paystack'
    });
  } catch (e) {
    await pool.query(`UPDATE escrow_transactions SET status='failed' WHERE id=$1`, [escrow.id]);
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/escrow', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, b.start_date,b.end_date,b.total,l.name AS listing_name
       FROM escrow_transactions e
       JOIN bookings b ON b.id=e.booking_id
       JOIN listings l ON l.id=b.listing_id
      WHERE e.user_id=$1 OR l.owner_id=$1
      ORDER BY e.created_at DESC`, [req.user.id]);
  res.json(result.rows);
});

app.post('/api/payments/verify', auth, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'Payment reference is required.' });
  if (!PAYSTACK_SECRET_KEY) return res.status(400).json({ error: 'PAYSTACK_SECRET_KEY is not configured.' });

  try {
    const result = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`, null, 'GET');
    const payment = result.data;
    const escrow = await pool.query(
      `SELECT e.*,b.renter_id,b.id AS booking_id
         FROM escrow_transactions e JOIN bookings b ON b.id=e.booking_id
        WHERE e.reference=$1 OR e.provider_reference=$1`, [reference]);
    if (!escrow.rowCount || Number(escrow.rows[0].user_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: 'Escrow transaction not found.' });
    }

    if (payment.status !== 'success') {
      await pool.query(`UPDATE escrow_transactions SET status='failed' WHERE id=$1`, [escrow.rows[0].id]);
      return res.json({ paid: false, status: payment.status });
    }

    const updated = await pool.query(
      `UPDATE escrow_transactions
          SET status='funded', funded_at=COALESCE(funded_at,NOW()),
              provider_reference=$1
        WHERE id=$2 RETURNING *`, [payment.reference, escrow.rows[0].id]);
    await pool.query(
      `UPDATE bookings SET status='confirmed'
        WHERE id=$1 AND status='pending'`, [escrow.rows[0].booking_id]);

    const contacts = await pool.query(
      `SELECT l.name AS item,r.name AS renter_name,r.email AS renter_email
         FROM bookings b JOIN listings l ON l.id=b.listing_id
         JOIN users r ON r.id=b.renter_id WHERE b.id=$1`, [escrow.rows[0].booking_id]);
    if (contacts.rowCount) notify(email.paymentConfirmed({to:contacts.rows[0].renter_email,name:contacts.rows[0].renter_name,item:contacts.rows[0].item,total:updated.rows[0].amount}));
    res.json({ paid: true, escrow: updated.rows[0] });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/payments/webhook', async (req, res) => {
  // Paystack signs the raw request body. Verify before changing financial state.
  if (!PAYSTACK_SECRET_KEY) return res.sendStatus(200);
  const signature = req.get('x-paystack-signature') || '';
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return res.sendStatus(401);
  }

  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }

  if (event.event === 'charge.success') {
    const reference = event.data?.reference;
    const result = await pool.query(
      `UPDATE escrow_transactions
          SET status='funded',funded_at=COALESCE(funded_at,NOW()),
              provider_reference=$1
        WHERE (reference=$1 OR provider_reference=$1)
          AND status IN ('payment_pending','created')
        RETURNING booking_id`, [reference]);
    if (result.rowCount) {
      await pool.query(
        `UPDATE bookings SET status='confirmed' WHERE id=$1 AND status='pending'`,
        [result.rows[0].booking_id]);
      const contacts = await pool.query(
        `SELECT l.name AS item,r.name AS renter_name,r.email AS renter_email
           FROM bookings b JOIN listings l ON l.id=b.listing_id
           JOIN users r ON r.id=b.renter_id WHERE b.id=$1`, [result.rows[0].booking_id]);
      if (contacts.rowCount) notify(email.paymentConfirmed({to:contacts.rows[0].renter_email,name:contacts.rows[0].renter_name,item:contacts.rows[0].item,total:event.data.amount/100}));
    }
  }
  res.sendStatus(200);
});

app.post('/api/escrow/release', auth, requireRole('admin'), async (req, res) => {
  const { escrowId } = req.body || {};
  const result = await pool.query(
    `SELECT e.*,b.id AS booking_id,b.end_date,l.owner_id
       FROM escrow_transactions e
       JOIN bookings b ON b.id=e.booking_id
       JOIN listings l ON l.id=b.listing_id
      WHERE e.id=$1`, [escrowId]);
  if (!result.rowCount) return res.status(404).json({ error: 'Escrow transaction not found.' });
  const e = result.rows[0];
  if (e.status !== 'funded' && e.status !== 'release_pending') {
    return res.status(409).json({ error: `Escrow is ${e.status}; it cannot be released.` });
  }

  // The release is an internal ledger state. Actual transfer to a lender requires
  // a configured provider payout/subaccount workflow.
  const updated = await pool.query(
    `UPDATE escrow_transactions
        SET status='released',released_at=NOW()
      WHERE id=$1 RETURNING *`, [escrowId]);

  await pool.query(
    `INSERT INTO payouts(lender_id,booking_id,amount,status)
     VALUES($1,$2,$3,'pending')`,
    [e.owner_id,e.booking_id,e.amount]);

  await pool.query(`UPDATE bookings SET status='completed' WHERE id=$1`, [e.booking_id]);
  res.json({ escrow: updated.rows[0], message: 'Escrow released to the lender payout queue.' });
});

app.post('/api/escrow/dispute', auth, async (req, res) => {
  const { escrowId, reason, details='' } = req.body || {};
  const result = await pool.query(
    `SELECT e.*,b.id AS booking_id,l.owner_id
       FROM escrow_transactions e
       JOIN bookings b ON b.id=e.booking_id
       JOIN listings l ON l.id=b.listing_id
      WHERE e.id=$1 AND (b.renter_id=$2 OR l.owner_id=$2)`, [escrowId,req.user.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Escrow transaction not found.' });
  if (!reason) return res.status(400).json({ error: 'Dispute reason is required.' });

  await pool.query(`UPDATE escrow_transactions SET status='disputed' WHERE id=$1`, [escrowId]);
  const dispute = await pool.query(
    `INSERT INTO disputes(booking_id,reporter_id,listing_id,reason,details)
     VALUES($1,$2,(SELECT listing_id FROM bookings WHERE id=$1),$3,$4)
     RETURNING *`,
    [result.rows[0].booking_id,req.user.id,reason,details]);
  const parties = await pool.query(
    `SELECT l.name AS item, renter.name AS renter_name, renter.email AS renter_email,
            lender.name AS lender_name, lender.email AS lender_email
       FROM bookings b
       JOIN listings l ON l.id=b.listing_id
       JOIN users renter ON renter.id=b.renter_id
       JOIN users lender ON lender.id=l.owner_id
      WHERE b.id=$1`, [result.rows[0].booking_id]);
  if (parties.rowCount) {
    const x = parties.rows[0];
    const recipient = Number(req.user.id) === Number(result.rows[0].owner_id) ?
      {to:x.renter_email,name:x.renter_name} : {to:x.lender_email,name:x.lender_name};
    notify(email.disputeCreated({to:recipient.to,name:recipient.name,item:x.item,reason}));
  }
  res.status(201).json({ dispute: dispute.rows[0] });
});

const ADMIN_BOOTSTRAP_KEY = process.env.ADMIN_BOOTSTRAP_KEY || '';
app.post('/api/admin/bootstrap', auth, async (req,res)=>{ const {key}=req.body||{}; if(!ADMIN_BOOTSTRAP_KEY||key!==ADMIN_BOOTSTRAP_KEY)return res.status(403).json({error:'Invalid admin bootstrap key.'}); const a=await pool.query("SELECT COUNT(*)::int n FROM users WHERE role='admin'"); if(a.rows[0].n>0)return res.status(409).json({error:'Admin bootstrap is locked.'}); const r=await pool.query("UPDATE users SET role='admin' WHERE id=$1 RETURNING id,name,email,role",[req.user.id]); res.json({user:r.rows[0],message:'Admin enabled. Log in again.'}); });
app.get('/api/admin/overview',auth,requireRole('admin'),async(_q,res)=>{ const [u,l,b,e,p,d]=await Promise.all([pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE role='lender')::int lenders,COUNT(*) FILTER(WHERE role='member')::int members FROM users"),pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='active')::int active,COUNT(*) FILTER(WHERE status='pending-review')::int pending FROM listings"),pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='pending')::int pending,COUNT(*) FILTER(WHERE status='confirmed')::int confirmed,COUNT(*) FILTER(WHERE status='completed')::int completed FROM bookings"),pool.query("SELECT COUNT(*)::int total,COALESCE(SUM(amount) FILTER(WHERE status='funded'),0)::numeric funded,COUNT(*) FILTER(WHERE status='disputed')::int disputed FROM escrow_transactions"),pool.query("SELECT COUNT(*)::int total,COALESCE(SUM(amount) FILTER(WHERE status='pending'),0)::numeric pending_amount,COUNT(*) FILTER(WHERE status='paid')::int paid FROM payouts"),pool.query("SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='open')::int open FROM disputes")]); res.json({users:u.rows[0],listings:l.rows[0],bookings:b.rows[0],escrow:e.rows[0],payouts:p.rows[0],disputes:d.rows[0]}); });
app.get('/api/admin/users',auth,requireRole('admin'),async(_q,res)=>res.json((await pool.query('SELECT id,name,email,role,created_at FROM users ORDER BY created_at DESC')).rows));
app.post('/api/admin/users/:id/role',auth,requireRole('admin'),async(req,res)=>{const {role}=req.body||{};if(!['member','lender','admin'].includes(role))return res.status(400).json({error:'Invalid role.'});if(Number(req.params.id)===Number(req.user.id)&&role!=='admin')return res.status(400).json({error:'You cannot remove your own admin role.'});const r=await pool.query('UPDATE users SET role=$1 WHERE id=$2 RETURNING id,name,email,role',[role,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'User not found.'});res.json(r.rows[0]);});
app.get('/api/admin/listings',auth,requireRole('admin'),async(req,res)=>{const p=[],w=[];if(req.query.status&&['pending-review','active','rejected','suspended'].includes(req.query.status)){p.push(req.query.status);w.push('l.status=$1')}const sql='SELECT l.*,u.name owner_name,u.email owner_email FROM listings l JOIN users u ON u.id=l.owner_id '+(w.length?'WHERE '+w.join(' AND '):'')+' ORDER BY l.created_at DESC';res.json((await pool.query(sql,p)).rows);});
app.post('/api/admin/listings/:id/status',auth,requireRole('admin'),async(req,res)=>{const {status}=req.body||{};if(!['pending-review','active','rejected','suspended'].includes(status))return res.status(400).json({error:'Invalid listing status.'});const r=await pool.query('UPDATE listings SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Listing not found.'});const owner=await pool.query('SELECT u.name,u.email,l.name AS item FROM listings l JOIN users u ON u.id=l.owner_id WHERE l.id=$1',[req.params.id]);if(owner.rowCount)notify(email.listingStatus({to:owner.rows[0].email,name:owner.rows[0].name,item:owner.rows[0].item,status}));res.json(r.rows[0]);});
app.get('/api/admin/bookings',auth,requireRole('admin'),async(_q,res)=>res.json((await pool.query('SELECT b.*,l.name listing_name,u.name renter_name,owner.name lender_name FROM bookings b JOIN listings l ON l.id=b.listing_id JOIN users u ON u.id=b.renter_id JOIN users owner ON owner.id=l.owner_id ORDER BY b.created_at DESC')).rows));
app.post('/api/admin/bookings/:id/status',auth,requireRole('admin'),async(req,res)=>{const {status}=req.body||{};if(!['pending','confirmed','cancelled','completed','rejected'].includes(status))return res.status(400).json({error:'Invalid booking status.'});const r=await pool.query('UPDATE bookings SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Booking not found.'});res.json(r.rows[0]);});
app.get('/api/admin/escrow',auth,requireRole('admin'),async(_q,res)=>res.json((await pool.query('SELECT e.*,l.name listing_name,r.name renter_name,o.name lender_name FROM escrow_transactions e JOIN bookings b ON b.id=e.booking_id JOIN listings l ON l.id=b.listing_id JOIN users r ON r.id=b.renter_id JOIN users o ON o.id=l.owner_id ORDER BY e.created_at DESC')).rows));
app.get('/api/admin/payouts',auth,requireRole('admin'),async(_q,res)=>res.json((await pool.query('SELECT p.*,u.name lender_name,l.name listing_name FROM payouts p JOIN users u ON u.id=p.lender_id LEFT JOIN bookings b ON b.id=p.booking_id LEFT JOIN listings l ON l.id=b.listing_id ORDER BY p.created_at DESC')).rows));
app.post('/api/admin/payouts/:id/status',auth,requireRole('admin'),async(req,res)=>{const {status}=req.body||{};if(!['pending','paid','failed'].includes(status))return res.status(400).json({error:'Invalid payout status.'});const r=await pool.query('UPDATE payouts SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Payout not found.'});const owner=await pool.query('SELECT u.name,u.email,p.amount FROM payouts p JOIN users u ON u.id=p.lender_id WHERE p.id=$1',[req.params.id]);if(owner.rowCount)notify(email.payoutStatus({to:owner.rows[0].email,name:owner.rows[0].name,amount:owner.rows[0].amount,status}));res.json(r.rows[0]);});

app.get('/api/notifications/status', auth, async (req,res)=>{ res.json({configured:Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM), provider:'Resend'}); });
app.post('/api/notifications/test', auth, requireRole('admin'), async (req,res)=>{ const to=String(req.body?.to||'').trim().toLowerCase(); if(!to)return res.status(400).json({error:'Recipient email is required.'}); try { const result=await email.sendEmail({to,subject:'Rental Marketplace email test',html:'<p>Email notifications are configured and working.</p>',text:'Rental Marketplace email notifications are configured and working.'}); res.json(result); } catch(e) { res.status(502).json({error:e.message}); } });

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Rental Marketplace running at http://localhost:${PORT}`);
});
