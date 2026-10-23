# JAI MARUTHI AUTOMATION — Attendance Web Software (Supabase)

This version uses **Supabase PostgreSQL** for the attendance data instead of the previous local SQLite database.

## 1. Create the Supabase database

Open your Supabase project and go to **SQL Editor**. Run the complete `supabase-schema.sql` file.

Use your own Supabase Project URL (Project Settings -> API):
`https://YOUR_PROJECT.supabase.co`

## 2. Configure the server secret

Copy `.env.example` to `.env` and set:

- `SUPABASE_URL=https://YOUR_PROJECT.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=...` — paste the server-side secret/service-role key from Supabase API Keys.
- `SESSION_SECRET=...` — use a long random secret.

**Never put the service-role/secret key in `public/index.html`, GitHub, or browser JavaScript.** The publishable key may be used client-side, but this application keeps database access behind the Node server for stronger security.

## 3. Install and run

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## 4. First login

On first launch, use the existing Admin Setup flow to create the first Super Admin. Subsequent admin registrations require Super Admin approval.

## Daily log (new)

Workers write today's task in the **Daily log** card and press **Send request**. Admins see it under the **Daily Log** tab (with a pending badge) and approve or deny it.

- **Approved:** the log is saved and appears in the reports, Daily activity and CSV downloads.
- **Denied:** the worker's name is kept and the log is shown as **"Daily log not provided"** in the Daily Log history, Daily activity and CSV downloads. The worker can edit and send it again.
- **Check-out is NOT locked.** Workers can check out whether or not the log is approved.

**Existing database?** Run `supabase-migration-daily-log.sql` once in the Supabase SQL Editor to create the `daily_logs` table.

## Member calendar (new)

On the admin Overview, click a member's **name** (or the **Calendar** button) to open a monthly calendar for that person. Each day shows check-in/out times, hours worked and **OT** (over 9 hours), plus **Absent**, **Comp-off** and approved **Leave** days, and a "Log not provided" note when the daily log was denied. A summary at the top totals present days, absent, comp-off, leave days, total hours and OT hours. Use Prev / Next to change month.

## Downloads: daily log + overtime (new)

All CSV downloads (admin Report, admin Daily activity, and the worker's **Download report**) open directly in Excel and now include: **Hours Worked**, **Regular Hours (max 9)**, **OT Hours (over 9)**, the **Daily Log Task** and its **status**. The activity and worker files end with a TOTAL row. OT is any worked time beyond 9 hours between check-in and check-out (no break is deducted); rows without a check-out have blank hours.

## Absent / Comp-off (new)

On the admin Overview, each member row has an **Absent / Comp-off** button. Pick the type, the date and an optional note, then save. The worker shows as **Absent** (red) or **Comp-off** (orange) on the dashboard and report, and cannot check in on that date. Marks can be removed from the same popup, and an admin check-in clears a mark for that day.

**Existing database?** Run `supabase-migration-absent-compoff.sql` once in the Supabase SQL Editor.

## Leave requests (new)

Workers pick a from/to date, write a reason and press **Send leave request** in the **Leave** card (they can cancel while it is pending). Admins review it in the **Leave** tab (with a pending badge). Once approved, the worker shows as **On leave** on the admin dashboard and cannot check in on those dates.

**Existing database?** Run `supabase-migration-leave.sql` once in the Supabase SQL Editor.

## Editing members and admin logins (new)

- **Members:** each row on the Overview page has an **Edit** button to fix the name, employee ID, department, or set a new PIN (leave the PIN blank to keep the current one).
- **Settings (gear icon):** every admin can change their own username and password (current password required). The super admin can also change another admin's username or reset their password.

## Attendance counts only after admin approval (new)

- The worker writes the **Daily log** and presses **Check out now**. The log and the check-out are sent to the admins together.
- The day is treated as **present only after an admin approves it** in the **Daily Log** tab. Until then (and if it is denied) that day is **blank** in the admin calendar, Daily Activity, and every CSV/Excel download.
- Attendance entered by an admin (admin check-in / check-out) counts immediately. Rows created before this update stay counted.
- **Member Edit is primary (super) admin only.** Other admins no longer see the Edit button, and the server rejects the request.

**Existing database?** Run `supabase-migration-approval-attendance.sql` once in the Supabase SQL Editor **before** deploying this version.

## Planned / Emergency leave and the Attendance Log (new)

- **Leave types:** when a worker sends a leave request they choose **Planned leave** or **Emergency leave**.
  - Planned leave must be submitted **at least one day before** it starts (the earliest start date is tomorrow).
  - Emergency leave can start today.
  - Admins see the type on every request (Leave tab) and in the member calendar.
- **Attendance Log tab (admin):** a member-wise monthly register with one row per member and one column per day, using **P** (Present), **A** (Absent), **PL** (Planned leave), **EL** (Emergency leave) and **CO** (Comp-off), plus totals per member. Use Prev / Next for other months, search for a member, click a name to open their calendar, and **Export CSV** for Excel.
  - Present counts only after the admin approves the daily log; until then the day shows **...** (awaiting approval) and is blank in the CSV.
  - Absent is automatic: a past working day (Mon-Sat) with no check-in, no leave and no Comp-off/Absent mark is counted as **Absent** (Sundays are skipped, and days before the member was added are ignored). On public holidays the admin should still mark the day so it is not counted as Absent.

**Existing database?** Run `supabase-migration-leave-type.sql` once in the Supabase SQL Editor (existing leave requests become Planned).

## Included

- Admin setup/login and multiple admin approval
- Worker login with **Worker ID + 4-digit PIN** (the Worker ID is the Employee ID the admin enters when adding the member; it must be unique)
- Check-in / check-out
- Manual time entry by workers has **no limit** (the old 'Manual x/y' counter and Reset limit button were removed)
- Daily dashboard and history
- CSV reports
- Supabase PostgreSQL persistence
- Server-side bcrypt password/PIN hashing
- Session authentication
- Rate limiting and security headers
- Responsive web interface

## Password reset note

The current UI preserves the development OTP flow from the original software. For production, connect `/api/admin/password/otp` to an SMTP/email or SMS provider before enabling production password recovery.

## Changes in this version

- **Report status** is now one of **Present / Absent / Comp-off / Leave** (Sunday with no activity shows *Sunday off*). No check-in = Absent. The Report CSV uses the same status.
- **Manual-entry limit removed** (counter, Reset limit button, worker banner and the Report column).
- **CSV / calendar overtime** now counts after **9 hours** (Regular Hours max 9, OT over 9).
- **Settings -> All data:** browse and download Attendance, Members, Leave, Daily logs and Absent/Comp-off marks (last 30 / 90 / 365 days or all time).
- **Worker login by Worker ID + PIN** (no name drop-down). The member list is no longer sent to people who are not logged in. Failed worker logins are limited to 20 per 15 minutes per IP.
- **No SQL migration is needed** for this version.
