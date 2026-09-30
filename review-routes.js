const express = require('express');

function registerReviewRoutes(app, pool, auth) {
  app.get('/api/users/:id/reviews', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT rv.id, rv.booking_id, rv.listing_id, rv.reviewer_id,
               rv.reviewed_user_id, rv.rating, rv.comment, rv.created_at,
               reviewer.name AS reviewer_name,
               listing.name AS listing_name
          FROM reviews rv
          JOIN users reviewer ON reviewer.id = rv.reviewer_id
          JOIN listings listing ON listing.id = rv.listing_id
         WHERE rv.reviewed_user_id = $1
         ORDER BY rv.created_at DESC
      `, [req.params.id]);

      const summary = await pool.query(`
        SELECT COUNT(*)::int AS review_count,
               COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::numeric AS average_rating
          FROM reviews
         WHERE reviewed_user_id = $1
      `, [req.params.id]);

      res.json({
        summary: summary.rows[0],
        reviews: result.rows
      });
    } catch (e) {
      res.status(500).json({ error: 'Unable to load reviews.' });
    }
  });

  app.get('/api/users/:id/rating', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT COUNT(*)::int AS review_count,
               COALESCE(ROUND(AVG(rating)::numeric, 1), 0)::numeric AS average_rating,
               COUNT(*) FILTER (WHERE rating=5)::int AS five_star,
               COUNT(*) FILTER (WHERE rating=4)::int AS four_star,
               COUNT(*) FILTER (WHERE rating=3)::int AS three_star,
               COUNT(*) FILTER (WHERE rating=2)::int AS two_star,
               COUNT(*) FILTER (WHERE rating=1)::int AS one_star
          FROM reviews
         WHERE reviewed_user_id = $1
      `, [req.params.id]);
      res.json(result.rows[0]);
    } catch (e) {
      res.status(500).json({ error: 'Unable to load rating.' });
    }
  });

  app.get('/api/bookings/:id/review', auth, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT rv.*
          FROM reviews rv
          JOIN bookings b ON b.id = rv.booking_id
          JOIN listings l ON l.id = b.listing_id
         WHERE rv.booking_id = $1
           AND rv.reviewer_id = $2
      `, [req.params.id, req.user.id]);

      res.json({ review: result.rows[0] || null });
    } catch (e) {
      res.status(500).json({ error: 'Unable to load booking review.' });
    }
  });

  app.post('/api/reviews', auth, async (req, res) => {
    const { bookingId, rating, comment = '' } = req.body || {};
    const numericRating = Number(rating);
    const text = String(comment || '').trim();

    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
      return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Review comment must be 2,000 characters or less.' });
    }

    try {
      const booking = await pool.query(`
        SELECT b.id, b.status, b.renter_id, b.start_date, b.end_date,
               l.id AS listing_id, l.owner_id, l.name AS listing_name
          FROM bookings b
          JOIN listings l ON l.id = b.listing_id
         WHERE b.id = $1
      `, [bookingId]);

      if (!booking.rowCount) return res.status(404).json({ error: 'Booking not found.' });
      const b = booking.rows[0];

      if (Number(b.owner_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Only the lender for this rental can submit this review.' });
      }
      if (b.status !== 'completed') {
        return res.status(409).json({ error: 'You can review this renter only after the rental is completed.' });
      }
      if (Number(b.renter_id) === Number(req.user.id)) {
        return res.status(400).json({ error: 'You cannot review yourself.' });
      }

      const inserted = await pool.query(`
        INSERT INTO reviews(
          booking_id, reviewer_id, reviewed_user_id, listing_id, rating, comment
        )
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING *
      `, [b.id, req.user.id, b.renter_id, b.listing_id, numericRating, text]);

      res.status(201).json({
        review: inserted.rows[0],
        message: 'Review submitted successfully.'
      });
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({ error: 'You have already reviewed this rental.' });
      }
      res.status(500).json({ error: 'Unable to submit review.' });
    }
  });
}

module.exports = { registerReviewRoutes };
