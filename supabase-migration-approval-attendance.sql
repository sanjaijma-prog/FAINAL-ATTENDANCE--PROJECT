-- Run this once in Supabase SQL Editor (adds "counted" to attendance).
-- A worker's day counts as present only after the admin approves the daily log / check-out request.
-- Existing rows stay counted (default true) so old reports do not go blank.
alter table public.attendance add column if not exists counted boolean not null default true;
