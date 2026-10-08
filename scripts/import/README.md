# Monthly workbook import (current path)

`xlsx_to_sql.py` turns the salon's DAILY SERVICE SALES REPORT workbooks
into one paste-ready SQL file for the Supabase SQL editor:

```sh
pip install openpyxl
python3 -I scripts/import/xlsx_to_sql.py -o import.sql \
  MAIN_DAILY_SERVICE_SALES_REPORT_09.2026.xlsx BRANCH_DAILY_SERVICE_SALES_REPORT_09.2026.xlsx
```

The generated SQL holds client names and phone numbers: never commit it.
Compare the expected totals it prints with the verification query at the
end of the run. Rules the converter follows (Aug–Sep 2026 batch onward):

- Shares are fitted to the 0034 share trigger: the workbook's TECHNICIAN
  SHARE is reproduced exactly and discounts come out of the company side.
- Services resolve by name within the business (0025: one name, one
  service); renamed services are mapped in `SERVICE_ALIASES`.
- Tickets attach to the surviving client of any merge; a new phone record
  whose name matches exactly one name-only record absorbs it.
- Imports never deactivate catalogue rows and never overwrite targets
  (pass `--set-targets` to apply the dashboard figure deliberately).
- Before importing, void any app-entered test tickets in the same months,
  or they double-count against the workbook.

# January–July 2026 history import (CSV path, superseded)

Imports the two existing workbooks (exported to CSV) into the database.
Server-side only: it uses the service-role key from the environment and must
never run in a browser (spec §8.3).

## Input format

One CSV per branch, one row per ticket line:

```
date,client_name,phone,service,technician,assist,qty,price,discount,payment,rating,time_started,time_ended
2026-01-05,Liza Reyes,09171112222,Keratin treatment,Ana Ramos,,1,3900,0,cash,5,10:30,14:00
```

- `price` and `discount` are in pesos; the importer converts to centavos.
- Rows on the same `date` with the same `phone` (or the same `client_name`
  when the phone is blank) merge into one ticket.
- A blank `phone` produces a walk-in client with `phone_declined = true`
  and one client record per (name, branch) so the history is preserved
  without inventing identities.
- Unknown services or technicians abort the run with a list of what is
  missing — fix the catalogue or the CSV first. Nothing partial is written.

## Idempotency (edge case 36)

Every imported ticket carries `idempotency_key = import:<branch>:<hash>`
derived from the row content. Running the import twice — or resuming after a
crash — cannot duplicate history: replays are skipped by the server.

## Run

```sh
SUPABASE_URL=https://YOUR-PROJECT.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/import/import.mjs --branch MAIN data/main-2026.csv
node scripts/import/import.mjs --branch BRANCH data/branch-2026.csv
```

Open question 7 (import as-is vs cleaned) is still with the client; the
importer takes the file as given and reports what it skipped.
