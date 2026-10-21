import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { AppError, asyncHandler } from '../errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

const searchSchema = z.object({
  source: z.string().trim().min(1).max(50),
  destination: z.string().trim().min(1).max(50),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// GET /api/flights?source=Mumbai&destination=Delhi&date=2026-11-01
router.get('/', asyncHandler(async (req, res) => {
  const { source, destination, date } = searchSchema.parse(req.query);
  // Range comparison (not DATE(col)) so the idx_flight_route index is used
  const flights = await query(
    `SELECT f.FlightID, f.FlightNo, f.Source, f.Destination, f.DepartureTime, f.ArrivalTime,
            f.Fare, a.Model AS AircraftModel
       FROM Flight f JOIN Aircraft a ON a.AircraftID = f.AircraftID
      WHERE f.Source = ? AND f.Destination = ?
        AND f.DepartureTime >= ? AND f.DepartureTime < DATE_ADD(?, INTERVAL 1 DAY)
        AND f.DepartureTime > NOW()
      ORDER BY f.DepartureTime`,
    [source, destination, date, date]
  );
  res.json(flights);
}));

// GET /api/flights/:id/seats  -> seats still free on THIS flight
router.get('/:id/seats', asyncHandler(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const [flight] = await query('SELECT AircraftID FROM Flight WHERE FlightID = ?', [id]);
  if (!flight) throw new AppError(404, 'Flight not found');

  const seats = await query(
    `SELECT s.SeatNumber, s.ClassType
       FROM Seat s
      WHERE s.AircraftID = ? AND s.Status <> 'Blocked'
        AND NOT EXISTS (
          SELECT 1 FROM Ticket t JOIN Booking b ON b.BookingID = t.BookingID
           WHERE b.FlightID = ? AND t.SeatNo = s.SeatNumber AND b.Status <> 'Cancelled')
      ORDER BY s.SeatNumber`,
    [flight.AircraftID, id]
  );
  res.json(seats);
}));

const createSchema = z.object({
  flightNo: z.string().trim().min(2).max(10),
  departureTime: z.coerce.date(),
  arrivalTime: z.coerce.date(),
  fare: z.number().positive().max(1_000_000),
  source: z.string().trim().min(1).max(50),
  destination: z.string().trim().min(1).max(50),
  aircraftId: z.number().int().positive(),
}).refine((d) => d.arrivalTime > d.departureTime, { message: 'arrivalTime must be after departureTime' })
  .refine((d) => d.source !== d.destination, { message: 'source and destination must differ' });

// POST /api/flights  (admin only)
router.post('/', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const d = createSchema.parse(req.body);
  const r = await query(
    `INSERT INTO Flight (FlightNo, DepartureTime, ArrivalTime, Fare, Source, Destination, AircraftID)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [d.flightNo, d.departureTime, d.arrivalTime, d.fare, d.source, d.destination, d.aircraftId]
  );
  res.status(201).json({ flightId: r.insertId });
}));

export default router;
