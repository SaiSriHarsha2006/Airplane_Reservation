import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { config } from '../config.js';
import { AppError, asyncHandler } from '../errors.js';

const router = Router();

// Brute-force protection on login/register
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(50),
  lastName: z.string().trim().min(1).max(50),
  email: z.string().trim().toLowerCase().email().max(100),
  password: z.string().min(8).max(72), // bcrypt limit is 72 bytes
  phone: z.string().regex(/^\+?[0-9]{7,15}$/),
  gender: z.enum(['Male', 'Female', 'Other']),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  address: z.string().max(255).optional(),
});

const sign = (p) =>
  jwt.sign({ role: p.Role }, config.jwtSecret, {
    subject: String(p.PassengerID),
    algorithm: 'HS256',
    expiresIn: config.jwtExpiresIn,
  });

router.post('/register', authLimiter, asyncHandler(async (req, res) => {
  const d = registerSchema.parse(req.body);
  const hash = await bcrypt.hash(d.password, 12);
  // Role is always 'passenger' here; admins are created manually in the DB.
  const result = await query(
    `INSERT INTO Passenger (FirstName, LastName, Email, Phone, Gender, DOB, Address, PasswordHash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.firstName, d.lastName, d.email, d.phone, d.gender, d.dob, d.address ?? null, hash]
  );
  res.status(201).json({ passengerId: result.insertId });
}));

router.post('/login', authLimiter, asyncHandler(async (req, res) => {
  const { email, password } = z
    .object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(72) })
    .parse(req.body);

  const [user] = await query(
    'SELECT PassengerID, PasswordHash, Role FROM Passenger WHERE Email = ?', [email]);

  // Same error for unknown email and wrong password (no user enumeration)
  const ok = user && user.PasswordHash && (await bcrypt.compare(password, user.PasswordHash));
  if (!ok) throw new AppError(401, 'Invalid email or password');

  res.json({ token: sign(user) });
}));

export default router;
