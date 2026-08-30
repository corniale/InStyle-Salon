-- opening_float_seed.sql — set the ₱1,000 standing change fund for MAIN
-- and BRANCH (questionnaire Q18). Adjustable any time in Settings →
-- Targets. Safe to rerun. Run as-is in the Supabase SQL editor.

update branches b
set opening_float_default_cents = 100000
from businesses biz
where biz.id = b.business_id
  and biz.code = 'SALON'
  and b.code in ('MAIN', 'BRANCH');

select b.code, b.name, b.opening_float_default_cents
from branches b
join businesses biz on biz.id = b.business_id and biz.code = 'SALON'
order by b.code;
