-- Add Work Side field for Daily Activity. Run once in Supabase SQL Editor.
ALTER TABLE public.attendance
ADD COLUMN IF NOT EXISTS work_side text;

ALTER TABLE public.attendance
DROP CONSTRAINT IF EXISTS attendance_work_side_check;

ALTER TABLE public.attendance
ADD CONSTRAINT attendance_work_side_check
CHECK (work_side IS NULL OR work_side IN ('Sunday', 'Public Leave', 'OT'));
