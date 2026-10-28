-- Run once in Supabase SQL Editor: allows Public holiday / Annual holiday marks.
alter table public.attendance_marks drop constraint if exists attendance_marks_type_check;
alter table public.attendance_marks
  add constraint attendance_marks_type_check
  check (type in ('absent','public_holiday','annual_holiday','compoff'));
