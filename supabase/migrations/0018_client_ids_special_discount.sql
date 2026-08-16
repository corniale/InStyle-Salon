-- 0018_client_ids_special_discount.sql — visible client IDs and a
-- client-level "Special" discount.
--
-- - clients.client_no: a sequential number (shown as C-000123) assigned to
--   every existing client by creation order and automatically to new ones.
-- - clients.special_discount_pct: a standing discount for this client
--   (e.g. Jane Doe 50% on all services). The POS carries it onto every
--   service line as discount type 'special' with the percent pre-filled.
-- - 'special' joins the ticket-line discount types, and merge_clients
--   carries the discount to the surviving record like a birthday.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

create sequence if not exists clients_client_no_seq;

alter table clients add column if not exists client_no bigint;

update clients c
   set client_no = s.rn
from (select id, row_number() over (order by created_at, id) as rn
      from clients) s
where s.id = c.id and c.client_no is null;

select setval('clients_client_no_seq',
              coalesce((select max(client_no) from clients), 0) + 1, false);

alter table clients alter column client_no set default nextval('clients_client_no_seq');
alter table clients alter column client_no set not null;
create unique index if not exists clients_client_no_key on clients (client_no);

alter table clients add column if not exists special_discount_pct numeric(5,2)
  check (special_discount_pct is null
         or (special_discount_pct > 0 and special_discount_pct <= 100));

alter table ticket_lines drop constraint if exists ticket_lines_discount_type_check;
alter table ticket_lines add constraint ticket_lines_discount_type_check
  check (discount_type in ('senior', 'pwd', 'staff', 'promo', 'negotiated',
                           'package', 'birthday', 'special'));

-- Merges carry the standing discount to the survivor when it has none.
create or replace function merge_clients(p_loser uuid, p_winner uuid)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_moved int;
begin
  if p_loser = p_winner then
    raise exception 'Pick two different client records to merge.'
      using errcode = 'check_violation', hint = 'merge_same_client';
  end if;

  update tickets set client_id = p_winner where client_id = p_loser;
  get diagnostics v_moved = row_count;

  update packages set client_id = p_winner where client_id = p_loser;
  update clients set referred_by_client_id = p_winner where referred_by_client_id = p_loser;

  update clients w
     set first_visit_on = least(coalesce(w.first_visit_on, l.first_visit_on),
                                coalesce(l.first_visit_on, w.first_visit_on)),
         full_name  = coalesce(w.full_name, l.full_name),
         barangay   = coalesce(w.barangay, l.barangay),
         town       = coalesce(w.town, l.town),
         birth_month = coalesce(w.birth_month, l.birth_month),
         birth_day   = coalesce(w.birth_day, l.birth_day),
         special_discount_pct = coalesce(w.special_discount_pct, l.special_discount_pct),
         notes      = concat_ws(E'\n', nullif(w.notes, ''), nullif(l.notes, ''))
    from clients l
   where w.id = p_winner and l.id = p_loser;

  update clients set merged_into_id = p_winner where id = p_loser;

  return jsonb_build_object('tickets_moved', v_moved, 'winner', p_winner);
end
$$;

select count(*) as clients_numbered,
       min(client_no) as first_no,
       max(client_no) as last_no
from clients;
