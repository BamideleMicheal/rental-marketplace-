const { Pool } = require('pg');
const email = require('./email');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, ssl: false });

function notify(promise) {
  Promise.resolve(promise).catch(err => console.error('Email notification failed:', err.message));
}

async function run() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

  const result = await pool.query(`
    SELECT b.id,b.start_date,b.end_date,l.name AS item,
           renter.name AS renter_name,renter.email AS renter_email,
           lender.name AS lender_name,lender.email AS lender_email
      FROM bookings b
      JOIN listings l ON l.id=b.listing_id
      JOIN users renter ON renter.id=b.renter_id
      JOIN users lender ON lender.id=l.owner_id
     WHERE b.status='confirmed'
       AND (b.start_date=$1::date OR b.end_date=$2::date)
  `, [today, tomorrow]);

  for (const row of result.rows) {
    if (String(row.start_date).slice(0,10) === today) {
      const inserted = await pool.query(
        `INSERT INTO notification_log(booking_id,notification_type)
         VALUES($1,'rental-start-today')
         ON CONFLICT(booking_id,notification_type) DO NOTHING
         RETURNING id`, [row.id]
      );
      if (inserted.rowCount) {
        notify(email.rentalStartReminder({to:row.renter_email,name:row.renter_name,item:row.item,startDate:row.start_date,endDate:row.end_date}));
        notify(email.rentalStartReminder({to:row.lender_email,name:row.lender_name,item:row.item,startDate:row.start_date,endDate:row.end_date}));
      }
    }

    if (String(row.end_date).slice(0,10) === tomorrow) {
      const inserted = await pool.query(
        `INSERT INTO notification_log(booking_id,notification_type)
         VALUES($1,'return-tomorrow')
         ON CONFLICT(booking_id,notification_type) DO NOTHING
         RETURNING id`, [row.id]
      );
      if (inserted.rowCount) {
        notify(email.returnReminder({to:row.renter_email,name:row.renter_name,item:row.item,endDate:row.end_date}));
        notify(email.returnReminder({to:row.lender_email,name:row.lender_name,item:row.item,endDate:row.end_date}));
      }
    }
  }

  await pool.end();
  console.log(`Rental reminders processed for ${today}; found ${result.rowCount} matching booking(s).`);
}

run().catch(async err => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
