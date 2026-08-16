-- 0019_revise_ticket.sql — formal ticket revision: void + corrected
-- re-entry as one atomic act, remarks required.
--
-- A saved ticket stays write-once. revise_ticket creates the corrected
-- ticket and voids the original in a single transaction, stamping the
-- void reason with the replacement's ticket number and the mandatory
-- remarks, so the audit trail reads: original (struck out, why, and by
-- whom via the audit log) -> replacement. Permissions ride on the
-- existing rules: voiding needs manager+, so front desk cannot revise;
-- a closed day refuses until it is reopened.
--
-- Run as-is in the Supabase SQL editor (default role, no impersonation).

create or replace function revise_ticket(
  p_original uuid, p_remarks text, p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_remarks text := nullif(btrim(p_remarks), '');
  v_new     jsonb;
begin
  if v_remarks is null then
    raise exception 'A revision needs remarks for the audit trail.'
      using errcode = 'check_violation', hint = 'remarks_required';
  end if;

  if exists (select 1 from tickets where id = p_original and voided_at is not null) then
    raise exception 'That ticket is already void.'
      using errcode = 'check_violation', hint = 'already_void';
  end if;

  v_new := create_ticket(p_payload);

  if (v_new ->> 'duplicate')::boolean then
    raise exception 'This revision was already saved.'
      using errcode = 'check_violation', hint = 'duplicate_revision';
  end if;

  perform void_ticket(
    p_original,
    'Revised as TS#' || coalesce(v_new ->> 'series_no', '?') || ' — ' || v_remarks);

  return v_new || jsonb_build_object('voided_original', p_original);
end
$$;

select 'revise_ticket ready' as check
where to_regprocedure('revise_ticket(uuid, text, jsonb)') is not null;
