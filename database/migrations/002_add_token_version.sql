-- Migration 002: Add token_version to profiles for JWT invalidation on password reset
-- Run: psql -d <dbname> -f database/migrations/002_add_token_version.sql

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
