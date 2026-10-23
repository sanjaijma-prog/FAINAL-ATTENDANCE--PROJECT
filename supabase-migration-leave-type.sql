-- Run this once in Supabase SQL Editor (adds Planned / Emergency leave types).
-- Existing leave requests become 'planned'.
alter table public.leave_requests
  add column if not exists leave_type text not null default 'planned'
  check (leave_type in ('planned','emergency'));
