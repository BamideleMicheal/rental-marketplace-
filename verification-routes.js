const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const PRIVATE_DIR = path.join(__dirname, 'private_uploads');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

const privateUpload = multer({
  storage: multer.diskStorage({
    destination: PRIVATE_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    cb(allowed.has(file.mimetype) ? null : new Error('Only JPG, PNG, WebP and PDF documents are allowed.'), allowed.has(file.mimetype));
  }
});

const allowedIdTypes = new Set([
  'National ID',
  'NIN Slip',
  'International Passport',
  'Driver Licence',
  'Voter Card'
]);

function clean(value) {
  return String(value ?? '').trim();
}

function requireFields(body, fields) {
  return fields.every(field => clean(body[field]));
}

function registerVerificationRoutes(app, pool, auth, requireRole) {
  app.get('/api/profile', auth, async (req, res) => {
    const result = await pool.query(
      `SELECT u.id,u.name,u.email,u.role,
              p.first_name,p.middle_name,p.surname,p.date_of_birth,p.gender,p.phone,
              p.residential_address,p.lga,p.state,p.country,p.occupation,
              p.profile_photo_path,p.verification_status,p.verified_at
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id=u.id
        WHERE u.id=$1`, [req.user.id]
    );
    res.json({ profile: result.rows[0] });
  });

  app.put('/api/profile', auth, async (req, res) => {
    const b = req.body || {};
    if (!requireFields(b, ['firstName', 'surname'])) {
      return res.status(400).json({ error: 'First name and surname are required.' });
    }
    if (b.country && clean(b.country) !== 'Nigeria') {
      return res.status(400).json({ error: 'Country must be Nigeria.' });
    }
    const result = await pool.query(
      `INSERT INTO user_profiles
        (user_id,first_name,middle_name,surname,date_of_birth,gender,phone,residential_address,lga,state,country,occupation)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Nigeria',$11)
       ON CONFLICT(user_id) DO UPDATE SET
        first_name=EXCLUDED.first_name,middle_name=EXCLUDED.middle_name,surname=EXCLUDED.surname,
        date_of_birth=EXCLUDED.date_of_birth,gender=EXCLUDED.gender,phone=EXCLUDED.phone,
        residential_address=EXCLUDED.residential_address,lga=EXCLUDED.lga,state=EXCLUDED.state,
        country='Nigeria',occupation=EXCLUDED.occupation,updated_at=NOW()
       RETURNING *`,
      [req.user.id,clean(b.firstName),clean(b.middleName),clean(b.surname),
       b.dateOfBirth || null,clean(b.gender),clean(b.phone),clean(b.residentialAddress),
       clean(b.lga),clean(b.state),clean(b.occupation)]
    );
    res.json({ profile: result.rows[0] });
  });

  app.post('/api/profile/photo', auth, (req, res) => {
    privateUpload.single('photo')(req, res, async err => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Profile photo is required.' });
      try {
        await pool.query(
          `INSERT INTO user_profiles(user_id,first_name,surname,profile_photo_path)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(user_id) DO UPDATE SET profile_photo_path=EXCLUDED.profile_photo_path,updated_at=NOW()`,
          [req.user.id, '', '', req.file.filename]
        );
        res.status(201).json({ uploaded: true });
      } catch (e) {
        fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: 'Profile photo could not be saved.' });
      }
    });
  });

  app.post('/api/verification/identity', auth, (req, res) => {
    privateUpload.single('idDocument')(req, res, async err => {
      if (err) return res.status(400).json({ error: err.message });
      const b = req.body || {};
      if (!allowedIdTypes.has(clean(b.idType)) || !clean(b.idNumber) || !req.file) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: 'Valid ID type, ID number and ID document are required.' });
      }
      try {
        const result = await pool.query(
          `INSERT INTO user_verifications(user_id,id_type,id_number,id_document_path)
           VALUES($1,$2,$3,$4) RETURNING id,user_id,id_type,id_number,status,created_at`,
          [req.user.id,clean(b.idType),clean(b.idNumber),req.file.filename]
        );
        await pool.query(
          `INSERT INTO user_profiles(user_id,first_name,surname,verification_status)
           VALUES($1,'','s','submitted')
           ON CONFLICT(user_id) DO UPDATE SET verification_status='submitted',updated_at=NOW()`,
          [req.user.id]
        );
        res.status(201).json({ verification: result.rows[0] });
      } catch (e) {
        fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: 'Identity verification could not be submitted.' });
      }
    });
  });

  app.post('/api/guarantors', auth, (req, res) => {
    privateUpload.fields([{name:'idDocument',maxCount:1}])(req, res, async err => {
      if (err) return res.status(400).json({ error: err.message });
      const b=req.body||{};
      if (!requireFields(b,['firstName','surname','relationship','phone','residentialAddress']) || String(b.consentConfirmed)!=='true') {
        return res.status(400).json({ error: 'Complete guarantor details and confirm guarantor consent.' });
      }
      const file=req.files?.idDocument?.[0];
      try {
        const result=await pool.query(
          `INSERT INTO guarantors
            (renter_id,first_name,middle_name,surname,relationship,phone,residential_address,lga,state,country,id_type,id_number,id_document_path,consent_confirmed)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'Nigeria',$10,$11,$12,TRUE)
           RETURNING id,renter_id,first_name,middle_name,surname,relationship,phone,status,created_at`,
          [req.user.id,clean(b.firstName),clean(b.middleName),clean(b.surname),clean(b.relationship),
           clean(b.phone),clean(b.residentialAddress),clean(b.lga),clean(b.state),
           clean(b.idType)||null,clean(b.idNumber)||null,file?.filename||null]
        );
        res.status(201).json({ guarantor: result.rows[0] });
      } catch (e) {
        if(file) fs.unlink(file.path,()=>{});
        res.status(500).json({ error: 'Guarantor could not be saved.' });
      }
    });
  });

  app.get('/api/guarantors', auth, async (req,res) => {
    const result=await pool.query(
      `SELECT id,first_name,middle_name,surname,relationship,phone,residential_address,lga,state,
              country,id_type,id_number,consent_confirmed,status,created_at
         FROM guarantors WHERE renter_id=$1 ORDER BY created_at DESC`,[req.user.id]);
    res.json({guarantors:result.rows});
  });

  app.post('/api/listings/:id/ownership-verification', auth, (req,res) => {
    privateUpload.fields([
      {name:'evidence',maxCount:1},
      {name:'authorizationAgreement',maxCount:1}
    ])(req,res,async err=>{
      if(err)return res.status(400).json({error:err.message});
      const b=req.body||{};
      const evidence=req.files?.evidence?.[0];
      const agreement=req.files?.authorizationAgreement?.[0];
      const ownershipType=clean(b.ownershipType);
      if(!['owner','authorized-agent'].includes(ownershipType)||!evidence){
        [evidence,agreement].filter(Boolean).forEach(f=>fs.unlink(f.path,()=>{}));
        return res.status(400).json({error:'Ownership type and supporting evidence are required.'});
      }
      try{
        const listing=await pool.query('SELECT id,owner_id FROM listings WHERE id=$1',[req.params.id]);
        if(!listing.rowCount||Number(listing.rows[0].owner_id)!==Number(req.user.id)){
          [evidence,agreement].filter(Boolean).forEach(f=>fs.unlink(f.path,()=>{}));
          return res.status(403).json({error:'You can only verify ownership for your own listing.'});
        }
        const result=await pool.query(
          `INSERT INTO item_verifications(listing_id,lender_id,ownership_type,evidence_path,authorization_agreement_path)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(listing_id) DO UPDATE SET
             lender_id=EXCLUDED.lender_id,ownership_type=EXCLUDED.ownership_type,
             evidence_path=EXCLUDED.evidence_path,authorization_agreement_path=EXCLUDED.authorization_agreement_path,
             status='submitted',reviewed_by=NULL,reviewed_at=NULL,rejection_reason=''
           RETURNING id,listing_id,lender_id,ownership_type,status,created_at`,
          [req.params.id,req.user.id,ownershipType,evidence.filename,agreement?.filename||null]
        );
        res.status(201).json({verification:result.rows[0]});
      }catch(e){
        [evidence,agreement].filter(Boolean).forEach(f=>fs.unlink(f.path,()=>{}));
        res.status(500).json({error:'Ownership verification could not be submitted.'});
      }
    });
  });

  app.get('/api/verification/me', auth, async (req,res)=>{
    const [profile,ids,guarantors,items]=await Promise.all([
      pool.query('SELECT * FROM user_profiles WHERE user_id=$1',[req.user.id]),
      pool.query('SELECT id,id_type,id_number,status,reviewed_at,rejection_reason,created_at FROM user_verifications WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id]),
      pool.query('SELECT id,first_name,middle_name,surname,relationship,phone,state,status,created_at FROM guarantors WHERE renter_id=$1 ORDER BY created_at DESC',[req.user.id]),
      pool.query('SELECT iv.id,iv.listing_id,l.name AS listing_name,iv.ownership_type,iv.status,iv.reviewed_at,iv.rejection_reason FROM item_verifications iv JOIN listings l ON l.id=iv.listing_id WHERE iv.lender_id=$1 ORDER BY iv.created_at DESC',[req.user.id])
    ]);
    res.json({profile:profile.rows[0]||null,identity:ids.rows,guarantors:guarantors.rows,itemVerifications:items.rows});
  });

  app.get('/api/admin/verifications', auth, requireRole('admin'), async (_req,res)=>{
    const [ids,guarantors,items]=await Promise.all([
      pool.query(`SELECT v.*,u.name,u.email FROM user_verifications v JOIN users u ON u.id=v.user_id ORDER BY v.created_at DESC`),
      pool.query(`SELECT g.*,u.name AS renter_name,u.email AS renter_email FROM guarantors g JOIN users u ON u.id=g.renter_id ORDER BY g.created_at DESC`),
      pool.query(`SELECT v.*,l.name AS listing_name,u.name AS lender_name,u.email AS lender_email FROM item_verifications v JOIN listings l ON l.id=v.listing_id JOIN users u ON u.id=v.lender_id ORDER BY v.created_at DESC`)
    ]);
    res.json({identity:ids.rows,guarantors:guarantors.rows,itemVerifications:items.rows});
  });

  app.post('/api/admin/verifications/:kind/:id/review', auth, requireRole('admin'), async (req,res)=>{
    const {status,rejectionReason=''}=req.body||{};
    if(!['verified','rejected'].includes(status))return res.status(400).json({error:'Status must be verified or rejected.'});
    const id=Number(req.params.id);
    let result;
    if(req.params.kind==='identity'){
      result=await pool.query(`UPDATE user_verifications SET status=$1,reviewed_by=$2,reviewed_at=NOW(),rejection_reason=$3 WHERE id=$4 RETURNING *`,[status,req.user.id,rejectionReason,id]);
      if(result.rowCount) await pool.query(`UPDATE user_profiles SET verification_status=$1,verified_by=$2,verified_at=CASE WHEN $1='verified' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE user_id=$3`,[status,req.user.id,result.rows[0].user_id]);
    } else if(req.params.kind==='guarantor'){
      result=await pool.query(`UPDATE guarantors SET status=$1,reviewed_by=$2,reviewed_at=NOW(),rejection_reason=$3 WHERE id=$4 RETURNING *`,[status,req.user.id,rejectionReason,id]);
    } else if(req.params.kind==='item'){
      result=await pool.query(`UPDATE item_verifications SET status=$1,reviewed_by=$2,reviewed_at=NOW(),rejection_reason=$3 WHERE id=$4 RETURNING *`,[status,req.user.id,rejectionReason,id]);
    } else return res.status(400).json({error:'Unknown verification type.'});
    if(!result.rowCount)return res.status(404).json({error:'Verification record not found.'});
    res.json({verification:result.rows[0]});
  });

  app.get('/api/verification/document/:kind/:id', auth, async (req,res)=>{
    const id=Number(req.params.id);
    let row;
    if(req.params.kind==='identity'){
      const r=await pool.query('SELECT user_id,id_document_path FROM user_verifications WHERE id=$1',[id]); row=r.rows[0];
      if(!row)return res.sendStatus(404);
      if(Number(row.user_id)!==Number(req.user.id) && req.user.role!=='admin')return res.sendStatus(403);
    } else if(req.params.kind==='guarantor'){
      const r=await pool.query('SELECT renter_id,id_document_path FROM guarantors WHERE id=$1',[id]); row=r.rows[0];
      if(!row)return res.sendStatus(404);
      if(Number(row.renter_id)!==Number(req.user.id) && req.user.role!=='admin')return res.sendStatus(403);
    } else if(req.params.kind==='item'){
      const r=await pool.query('SELECT lender_id,evidence_path,authorization_agreement_path FROM item_verifications WHERE id=$1',[id]); row=r.rows[0];
      if(!row)return res.sendStatus(404);
      if(Number(row.lender_id)!==Number(req.user.id) && req.user.role!=='admin')return res.sendStatus(403);
      const name=req.query.agreement==='1'?row.authorization_agreement_path:row.evidence_path;
      if(!name)return res.sendStatus(404);
      return res.sendFile(path.join(PRIVATE_DIR,name));
    } else return res.sendStatus(400);
    if(!row.id_document_path)return res.sendStatus(404);
    res.sendFile(path.join(PRIVATE_DIR,row.id_document_path));
  });
}

module.exports = { registerVerificationRoutes };
