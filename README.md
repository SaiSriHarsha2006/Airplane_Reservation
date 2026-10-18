# Airline Reservation API (Node.js + Express + MySQL)

## Setup
1. Run `airplane_reservation_db.sql`, then `schema_additions.sql`
2. `cp .env.example .env` and fill in values (JWT_SECRET >= 32 chars)
3. `npm install && npm start`

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/register | - | Create passenger |
| POST | /api/auth/login | - | Get JWT |
| GET | /api/flights?source=&destination=&date= | - | Search flights |
| GET | /api/flights/:id/seats | - | Free seats on a flight |
| POST | /api/flights | admin | Add flight |
| POST | /api/bookings | user | Book flight + seat (creates ticket/PNR) |
| GET | /api/bookings | user | My bookings |
| GET | /api/bookings/:id | user | Booking + payments |
| POST | /api/bookings/:id/payments | user | Pay (confirms booking) |
| POST | /api/bookings/:id/cancel | user | Cancel + refund |

Make an admin: `UPDATE Passenger SET Role='admin' WHERE Email='you@example.com';`

## Security measures
- Prepared statements everywhere (SQL injection), multipleStatements off
- bcrypt (cost 12) password hashing, JWT HS256 with pinned algorithm + expiry
- zod validation on all input; fare/amount always taken from DB, never the client
- Ownership checks in SQL (users only see their own bookings)
- Transactions + row locks: no double-booked seats, no half-written data
- helmet, CORS allow-list, rate limits (global + stricter on login), 10kb body cap
- Errors never leak SQL/stack traces; least-privilege DB user
