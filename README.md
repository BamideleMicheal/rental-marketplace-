# Rental Marketplace

A runnable local Nigerian peer-to-peer rental marketplace built with Node.js, Express and PostgreSQL.

## Requirements

- Node.js 18+
- PostgreSQL 14+ recommended
- npm

## Local setup

1. Create a PostgreSQL database named `rental_marketplace`.
2. Set `DATABASE_URL`:

```bash
export DATABASE_URL="postgres://postgres:YOUR_PASSWORD@localhost:5432/rental_marketplace"
export SESSION_SECRET="replace-with-a-long-random-secret"
```

3. Install dependencies:

```bash
npm install
```

4. Initialize the database:

```bash
npm run db:init
```

5. Start the application:

```bash
npm start
```

6. Open:

```text
http://localhost:3000
```

For development:

```bash
npm run dev
```

## Architecture

Browser -> Express server -> PostgreSQL.

The backend is authoritative for authentication, listings, booking totals and date conflicts. The browser never creates a booking only in local state.

## Location model

Rental Marketplace uses:

`Nigeria -> State/FCT -> City -> Area`

The country is fixed to Nigeria. The state vocabulary contains Nigeria's 36 states plus FCT Abuja. City and area remain explicit listing fields so the system can represent cities and neighborhoods without hard-coding every neighborhood in the application.

## API

- `GET /api/health`
- `GET /api/locations`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/listings`
- `POST /api/listings`
- `POST /api/uploads`
- `GET /api/bookings`
- `POST /api/bookings`
- `GET /api/lender/payouts`
- `POST /api/disputes`
- `GET /api/admin/disputes`
- `POST /api/admin/disputes/:id/resolve`
- `POST /api/escrow/authorize`

## Important

The escrow endpoint creates an application record only. Real payment authorization, payouts, refunds and webhook handling must be connected to a PCI-compliant payment provider. Do not store card numbers in PostgreSQL.

## First admin account

Registration intentionally cannot create an admin account. For local development, promote an existing user manually:

```sql
UPDATE users SET role='admin' WHERE email='your-email@example.com';
```


## Escrow and payments

Rental Marketplace now has an escrow state machine:

`created -> payment_pending -> funded -> release_pending -> released`

with `disputed`, `refund_pending`, `refunded`, and `failed` states.

For local development, escrow can run in **manual mode** when `PAYSTACK_SECRET_KEY` is absent. Manual mode creates the escrow ledger record but does not claim that real money was received.

### Paystack

If you want real checkout in a Nigerian deployment, set:

```bash
export PAYSTACK_SECRET_KEY="sk_test_..."
```

The server then initializes NGN checkout transactions and exposes:

- `POST /api/escrow/authorize`
- `POST /api/payments/verify`
- `POST /api/payments/webhook`
- `GET /api/escrow`
- `POST /api/escrow/dispute`
- `POST /api/escrow/release` (admin)

Configure the Paystack webhook URL to:

`https://YOUR-DOMAIN/api/payments/webhook`

The server verifies the webhook signature before changing escrow state.

**Important:** Paystack transaction splits/subaccounts are useful for marketplace settlement, but a split payment is not the same thing as a legally segregated escrow account. The application therefore treats its PostgreSQL escrow record as the platform's business-state ledger; the actual custody/settlement arrangement must match the payment provider's terms and the legal/regulatory structure of the marketplace.

For production, the platform should also complete KYC/KYB, lender bank-account verification, refund policy, dispute policy, provider payout configuration, webhook monitoring, and applicable Nigerian regulatory/legal review.
