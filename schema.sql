CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member','lender','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS listings (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  deposit NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  country TEXT NOT NULL DEFAULT 'Nigeria',
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  area TEXT NOT NULL,
  image TEXT NOT NULL,
  description TEXT NOT NULL,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending-review'
    CHECK (status IN ('pending-review','active','rejected','suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS listings_location_idx
  ON listings(country, state, city, area);
CREATE INDEX IF NOT EXISTS listings_category_idx
  ON listings(category);

CREATE TABLE IF NOT EXISTS bookings (
  id BIGSERIAL PRIMARY KEY,
  listing_id BIGINT NOT NULL REFERENCES listings(id),
  renter_id BIGINT NOT NULL REFERENCES users(id),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  total NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','confirmed','cancelled','completed','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date > start_date)
);

CREATE INDEX IF NOT EXISTS bookings_dates_idx
  ON bookings USING gist(listing_id, daterange(start_date, end_date, '[)'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_no_overlap
      EXCLUDE USING gist (
        listing_id WITH =,
        daterange(start_date, end_date, '[)') WITH &&
      )
      WHERE (status IN ('pending','confirmed'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS escrow_transactions (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  booking_id BIGINT NOT NULL REFERENCES bookings(id),
  user_id BIGINT NOT NULL REFERENCES users(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  provider TEXT NOT NULL DEFAULT 'manual',
  provider_reference TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created','payment_pending','funded','release_pending','released','refund_pending','refunded','disputed','failed')),
  funded_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
  id BIGSERIAL PRIMARY KEY,
  lender_id BIGINT NOT NULL REFERENCES users(id),
  booking_id BIGINT REFERENCES bookings(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS disputes (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id),
  reporter_id BIGINT NOT NULL REFERENCES users(id),
  listing_id BIGINT REFERENCES listings(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  resolved_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS provider_reference TEXT;
ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS funded_at TIMESTAMPTZ;
ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;
ALTER TABLE escrow_transactions ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS escrow_provider_reference_uq
  ON escrow_transactions(provider_reference) WHERE provider_reference IS NOT NULL;


-- Persistent shopping cart and per-item rental dates
CREATE TABLE IF NOT EXISTS carts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id BIGINT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  delivery_method TEXT NOT NULL DEFAULT 'self-pickup'
    CHECK (delivery_method IN ('self-pickup','delivery-return','delivery-only')),
  delivery_address TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, listing_id),
  CHECK (end_date > start_date)
);
CREATE INDEX IF NOT EXISTS carts_user_idx ON carts(user_id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivery_method TEXT NOT NULL DEFAULT 'self-pickup';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivery_address TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0);

CREATE TABLE IF NOT EXISTS deliveries (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT UNIQUE NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('delivery-return','delivery-only')),
  pickup_address TEXT NOT NULL DEFAULT '',
  delivery_address TEXT NOT NULL DEFAULT '',
  courier_name TEXT,
  courier_phone TEXT,
  tracking_code TEXT UNIQUE,
  outbound_status TEXT NOT NULL DEFAULT 'pending',
  return_status TEXT NOT NULL DEFAULT 'not-required',
  renter_received_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  renter_received_at TIMESTAMPTZ,
  renter_return_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  renter_return_at TIMESTAMPTZ,
  lender_return_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  lender_return_at TIMESTAMPTZ,
  damage_reported BOOLEAN NOT NULL DEFAULT FALSE,
  damage_details TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries(outbound_status,return_status);


-- Idempotent email reminder tracking
CREATE TABLE IF NOT EXISTS notification_log (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(booking_id, notification_type)
);
CREATE INDEX IF NOT EXISTS notification_log_booking_idx ON notification_log(booking_id);
