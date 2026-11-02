-- Run this once in Supabase SQL Editor (adds Public leave / Annual leave choice to Absent marks).
alter table public.attendance_marks
  add column if not exists sub_type text check (sub_type in ('public','annual'));
