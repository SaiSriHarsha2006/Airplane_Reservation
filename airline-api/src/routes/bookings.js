import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, withTransaction, q } from '../db.js';
import { AppError, asyncHandler } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

const idParam = z.coerce.number().int().positive();
const CLASSES = ['Economy', 'Premium Economy', 'Business', 'First'];

const genPNR = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike chars
  return Array.from(crypto.randomBytes(6), (b) => chars[b % chars.length]).join('');
};

// ---------- Create booking (+ ticket) atomically ----------
const bookSchema = z.object({
  flightId: z.number().int().positive(),
  classType: z.enum(CLASSES),
  seatNo: z.string().trim().toUpperCase().regex(/^\d{1,3}[A-Z]$/),
});

router.post('/', asyncHandler(async (req, res) => {
  const { flightId, classType, seatNo } = bookSchema.parse(req.body);

  const result = await withTransaction(async (conn) => {
    // Locking the flight row serialises concurrent bookings for the same flight,
    // so two people can never be given the same seat (no race condition).
    const [flight] = await q(conn,
      'SELECT AircraftID, Fare, DepartureTime FROM Flight WHERE FlightID = ? FOR UPDATE', [flightId]);
    if (!flight) throw new AppError(404, 'Flight not found');
    if (new Date(flight.DepartureTime) <= new Date()) throw new AppError(400, 'Flight already departed');

    const [seat] = await q(conn,
      'SELECT ClassType, Status FROM Seat WHERE AircraftID = ? AND SeatNumber = ?',
      [flight.AircraftID, seatNo]);
    if (!seat) throw new AppError(404, 'Seat does not exist on this aircraft');
    if (seat.Status === 'Blocked') throw new AppError(409, 'Seat unavailable');
    if (seat.ClassType !== classType) throw new AppError(400, `Seat ${seatNo} is ${seat.ClassType} class`);

    const taken = await q(conn,
      `SELECT 1 FROM Ticket t JOIN Booking b ON b.BookingID = t.BookingID
        WHERE b.FlightID = ? AND t.SeatNo = ? AND b.Status <> 'Cancelled'`, [flightId, seatNo]);
    if (taken.length) throw new AppError(409, 'Seat already booked');

    const b = await q(conn,
      `INSERT INTO Booking (Status, ClassType, PassengerID, FlightID) VALUES ('Pending', ?, ?, ?)`,
      [classType, req.user.id, flightId]);

    // Fare is read from the DB - the client can never set its own price.
    let pnr;
    for (let i = 0; i < 5; i++) {
      pnr = genPNR();
      try {
        await q(conn,
          'INSERT INTO Ticket (PNR, SeatNo, ClassType, Fare, BookingID) VALUES (?, ?, ?, ?, ?)',
          [pnr, seatNo, classType, flight.Fare, b.insertId]);
        break;
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY' || i === 4) throw e; // retry only on PNR collision
      }
    }
    return { bookingId: b.insertId, pnr, seatNo, fare: flight.Fare, status: 'Pending' };
  });

  res.status(201).json(result);
}));

// ---------- List my bookings ----------
router.get('/', asyncHandler(async (req, res) => {
  const rows = await query(
    `SELECT b.BookingID, b.BookingDate, b.Status, b.ClassType,
            f.FlightNo, f.Source, f.Destination, f.DepartureTime,
            t.PNR, t.SeatNo, t.Fare
       FROM Booking b
       JOIN Flight f ON f.FlightID = b.FlightID
       LEFT JOIN Ticket t ON t.BookingID = b.BookingID
      WHERE b.PassengerID = ?
      ORDER BY b.BookingDate DESC`, [req.user.id]);
  res.json(rows);
}));

// ---------- One booking (owner only) ----------
router.get('/:id', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  // PassengerID in the WHERE clause = ownership check (also blocks IDOR guessing)
  const [booking] = await query(
    `SELECT b.BookingID, b.BookingDate, b.Status, b.ClassType,
            f.FlightNo, f.Source, f.Destination, f.DepartureTime, f.ArrivalTime,
            t.PNR, t.SeatNo, t.Fare, t.IssueDate
       FROM Booking b
       JOIN Flight f ON f.FlightID = b.FlightID
       LEFT JOIN Ticket t ON t.BookingID = b.BookingID
      WHERE b.BookingID = ? AND b.PassengerID = ?`, [id, req.user.id]);
  if (!booking) throw new AppError(404, 'Booking not found');

  const payments = await query(
    `SELECT PaymentID, Amount, PaymentDate, PaymentMode, PaymentStatus
       FROM Payment WHERE BookingID = ?`, [id]);
  res.json({ ...booking, payments });
}));

// ---------- Pay for a booking ----------
const paySchema = z.object({ paymentMode: z.enum(['Credit Card', 'Debit Card', 'UPI', 'Net Banking']) });

router.post('/:id/payments', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);
  const { paymentMode } = paySchema.parse(req.body);

  const result = await withTransaction(async (conn) => {
    const [b] = await q(conn,
      `SELECT b.Status, t.Fare FROM Booking b JOIN Ticket t ON t.BookingID = b.BookingID
        WHERE b.BookingID = ? AND b.PassengerID = ? FOR UPDATE`, [id, req.user.id]);
    if (!b) throw new AppError(404, 'Booking not found');
    if (b.Status !== 'Pending') throw new AppError(409, `Booking is already ${b.Status}`);

    // TODO: call your real payment gateway here and only continue if it succeeds.
    // Never store card numbers/CVV in this database.
    const p = await q(conn,
      `INSERT INTO Payment (Amount, PaymentMode, PaymentStatus, BookingID)
       VALUES (?, ?, 'Success', ?)`, [b.Fare, paymentMode, id]);
    await q(conn, `UPDATE Booking SET Status = 'Confirmed' WHERE BookingID = ?`, [id]);
    return { paymentId: p.insertId, amount: b.Fare, status: 'Success', bookingStatus: 'Confirmed' };
  });

  res.status(201).json(result);
}));

// ---------- Cancel booking (+ refund payments) ----------
router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const id = idParam.parse(req.params.id);

  await withTransaction(async (conn) => {
    const [b] = await q(conn,
      `SELECT b.Status, f.DepartureTime FROM Booking b JOIN Flight f ON f.FlightID = b.FlightID
        WHERE b.BookingID = ? AND b.PassengerID = ? FOR UPDATE`, [id, req.user.id]);
    if (!b) throw new AppError(404, 'Booking not found');
    if (b.Status === 'Cancelled') throw new AppError(409, 'Booking already cancelled');
    if (new Date(b.DepartureTime) <= new Date()) throw new AppError(400, 'Flight already departed');

    await q(conn, `UPDATE Booking SET Status = 'Cancelled' WHERE BookingID = ?`, [id]);
    await q(conn, `UPDATE Payment SET PaymentStatus = 'Refunded'
                    WHERE BookingID = ? AND PaymentStatus = 'Success'`, [id]);
  });

  res.json({ message: 'Booking cancelled', bookingId: id });
}));

export default router;
