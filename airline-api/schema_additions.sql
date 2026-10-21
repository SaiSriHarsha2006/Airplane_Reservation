-- Run once after airplane_reservation_db.sql
USE airplane_reservation;

ALTER TABLE Passenger
  ADD COLUMN PasswordHash VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN Role ENUM('passenger','admin') NOT NULL DEFAULT 'passenger';

-- Least-privilege DB user for the API (no DROP/ALTER/GRANT)
CREATE USER IF NOT EXISTS 'airline_app'@'localhost' IDENTIFIED BY 'change_me';
GRANT SELECT, INSERT, UPDATE, DELETE ON airplane_reservation.* TO 'airline_app'@'localhost';
FLUSH PRIVILEGES;
