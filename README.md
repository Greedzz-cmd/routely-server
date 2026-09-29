# Routely API

Express and MongoDB backend for the Routely ticket booking platform. It serves
the public ticket catalogue, vendor and admin management, the booking lifecycle
and Stripe payments.

## Purpose

The client is a Next.js app that owns authentication through Better Auth. This
API never handles passwords; it validates the JWT that Better Auth issues and
authorises every request from the claims in that token.

## Requirements

- Node.js 20 or newer
- A MongoDB Atlas cluster

## Getting started

```bash
npm install
cp .env.example .env    # then fill in the values
npm run dev             # nodemon-style reload via node --watch
npm start               # production start
```

The API listens on `PORT` (default 5000) and exposes `GET /health` for uptime
checks and platform health probes.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `PORT` | No | Port to listen on. Defaults to `5000`. |
| `MONGODB_URI` | Yes | MongoDB connection string, including credentials. |
| `MONGODB_DB` | No | Database name. Defaults to `routely`. |
| `AUTH_BASE_URL` | Yes | Base URL of the Next.js client that hosts the Better Auth endpoints. Tokens are verified against `${AUTH_BASE_URL}/api/auth/jwks`. |
| `AUTH_SECRET` | No | Shared secret, only needed if the client signs tokens with HS256 instead of RS256. |
| `CLIENT_URLS` | Yes | Comma separated list of allowed origins. Vercel preview domains are allowed automatically in production. |
| `PAYMENTS_MODE` | No | `stripe` for real Checkout, `mock` to run the full flow without keys. Defaults to `mock`. |
| `STRIPE_SECRET_KEY` | With Stripe | Stripe secret key. |
| `STRIPE_WEBHOOK_SECRET` | With Stripe | Signing secret for the `/payments/webhook` endpoint. |
| `PAYMENT_CURRENCY` | No | Stripe currency code. Defaults to `bdt`. |
| `PAYMENT_SUCCESS_URL` | No | Where Stripe returns the customer after payment. |
| `PAYMENT_CANCEL_URL` | No | Where Stripe returns the customer if they cancel. |
| `IMGBB_API_KEY` | No | imgBB key for ticket image uploads. Without it `/uploads/image` returns 503 and the client falls back to a URL field. |

## Project structure

```
src/
├── config/       env parsing, Mongo connection and indexes, CORS policy
├── controllers/  request handling for each resource
├── middleware/   JWT auth, role guards, error handling, async wrapper
├── models/       data access, validation and query building
├── routes/       route tables, one per resource
├── services/     Stripe integration
├── utils/        ApiError
├── app.js        Express app, exported for testing
└── server.js     entry point, owns the connection lifecycle
```

## Authentication

`Better Auth` on the client issues a short lived JWT. The client sends it as
`Authorization: Bearer <token>` and this API verifies it against the client's
published JWKS, falling back to HS256 with `AUTH_SECRET` when the client signs
with the shared secret.

`requireAuth` populates `req.user`; `requireRole("admin")` and
`requireRole("vendor")` guard the areas that need them.

## Booking lifecycle

```
pending  ->  accepted  ->  paid
   |
   +------>  rejected
   |
   +------>  cancelled   (user, only while pending)
```

Ticket quantity is reduced when payment succeeds, not when the booking is
created. Until then, availability is derived from sold seats plus seats still
held by unanswered requests, so the catalogue cannot be oversold while
abandoned requests do not permanently consume inventory.

## Endpoints

**Public**

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Liveness probe. |
| GET | `/tickets` | Approved tickets. Supports `from`, `to`, `transportType`, `q`, `sort`, `page`, `limit`. |
| GET | `/tickets/advertised` | The six tickets featured on the homepage. |
| GET | `/tickets/locations` | Distinct origins and destinations for the search inputs. |
| GET | `/tickets/:id` | A single approved ticket. |

**User**

| Method | Path | Description |
| --- | --- | --- |
| GET | `/me` | The verified token payload. |
| GET | `/users/me` | The caller's stored record, including the fraud flag. |
| GET | `/bookings` | The caller's bookings. |
| POST | `/bookings` | Request a booking. Returns `pending`. |
| POST | `/bookings/:id/cancel` | Cancel, only while `pending`. |
| POST | `/bookings/:id/checkout` | Create a Stripe Checkout session. |
| POST | `/bookings/:id/confirm` | Confirm a mock payment (mock mode only). |
| GET | `/transactions` | The caller's payment history. |

**Vendor**

| Method | Path | Description |
| --- | --- | --- |
| POST | `/tickets` | Add a ticket as `pending`. |
| GET | `/tickets/me` | The vendor's own tickets with verification status. |
| PATCH | `/tickets/:id` | Update a ticket. Rejected tickets are locked. |
| DELETE | `/tickets/:id` | Delete a ticket with no active bookings. |
| PATCH | `/bookings/:id` | Accept or reject a pending request. |
| GET | `/vendor-stats` | Totals and a monthly series for the revenue chart. |
| POST | `/uploads/image` | Upload ticket imagery to imgBB. |

**Admin**

| Method | Path | Description |
| --- | --- | --- |
| GET | `/tickets/manage` | Every ticket, any verification status. |
| PATCH | `/tickets/:id/verification` | Approve or reject. |
| PATCH | `/tickets/:id/advertisement` | Advertise toggle, capped at six. |
| GET | `/users` | All accounts. |
| PATCH | `/users/:id/role` | Promote or demote. |
| PATCH | `/users/:id/fraud` | Flag a vendor as fraud, hiding their tickets. |
| GET | `/admin-stats` | Platform totals. |

**Payments**

| Method | Path | Description |
| --- | --- | --- |
| POST | `/payments/webhook` | Stripe webhook. Signature verified, idempotent. |
| POST | `/payments/confirm` | Confirm by looking a session up with Stripe. |

## Payments

Set `PAYMENTS_MODE=stripe` with real keys to take live payments. The webhook
handler is idempotent: Stripe's event retries cannot double charge a booking or
decrement a ticket twice, and the unique index on `transactions.bookingId`
keeps one payment record per booking.

In `mock` mode no Stripe call is made, so the whole flow is testable offline.

Point the Stripe webhook at `https://<your-api-host>/payments/webhook` and
subscribe to `checkout.session.completed`.

## Deployment

`render.yaml` provisions a Node web service that builds with `npm install`,
starts with `npm start` and health checks `/health`.

Set `MONGODB_URI`, `AUTH_BASE_URL`, `CLIENT_URLS`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` and `IMGBB_API_KEY` in the dashboard; they are declared
with `sync: false` so no secret is stored in this file.

For Atlas, either allowlist Render's outbound addresses or set
`NODE_OPTIONS=--dns-result-order=ipv4first`, which avoids the `SrvIOError` that
occurs when a host cannot resolve IPv6 first.

### Vercel

The repository also includes a Vercel function entry point at `api/index.js`.
Import the repository into Vercel with the project root set to this directory;
Vercel installs dependencies from `package.json` and `vercel.json` sends requests
to the Express app. Add `MONGODB_URI`, `MONGODB_DB`, `AUTH_BASE_URL`,
`CLIENT_URLS`, `PAYMENTS_MODE`, `PAYMENT_CURRENCY`, `PAYMENT_SUCCESS_URL`,
`PAYMENT_CANCEL_URL`, and any required Stripe or imgBB keys in the Vercel
project's Environment Variables settings. Set production `NODE_ENV` to
`production`, and include the deployed frontend origin in `CLIENT_URLS`.

The MongoDB Atlas network access rules must allow connections from Vercel's
serverless functions. If Atlas network restrictions prevent those connections,
requests that need the database will return 503 until network access is fixed.
The `/` and `/health` endpoints also pass through the database connection
because this API initializes its indexes before handling requests.
