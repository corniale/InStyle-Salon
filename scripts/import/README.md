# January–July 2026 history import

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
