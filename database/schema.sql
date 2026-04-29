-- database/schema.sql
-- Vyas-Backend Database Schema
-- PostgreSQL 13+ (uses gen_random_uuid() built-in)
-- Run: psql -d <dbname> -f database/schema.sql

-- ============================================================
-- PROFILES
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name   TEXT        NOT NULL,
  email       TEXT        UNIQUE NOT NULL,
  is_admin    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USER AUTH  (password hashes — separate from profiles)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_auth (
  user_id       UUID  PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  password_hash TEXT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BUILDINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS buildings (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- FLOORS
-- ============================================================
CREATE TABLE IF NOT EXISTS floors (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id  UUID        NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number INT,
  name         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ROOMS
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  floor_id   UUID        NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  room_type  TEXT,
  capacity   INT,
  equipment  TEXT[],
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS bookings (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        UUID        NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  teacher_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title          TEXT        NOT NULL,
  description    TEXT,
  start_time     TIMESTAMPTZ NOT NULL,
  end_time       TIMESTAMPTZ NOT NULL,
  class_division TEXT,
  panel          TEXT,
  year_course    TEXT,
  is_recurring   BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bookings_end_after_start CHECK (end_time > start_time)
);

-- Index used by the time-overlap conflict check in booking.js
CREATE INDEX IF NOT EXISTS idx_bookings_room_time
  ON bookings (room_id, start_time, end_time);

-- ============================================================
-- PASSWORD RESET TOKENS
-- ============================================================
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token
  ON password_reset_tokens (token);
