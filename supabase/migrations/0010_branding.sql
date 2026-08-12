-- Per-business branding. Each business carries its own identity accents:
-- a wordmark (with an optional accented substring), a tagline, a brand
-- colour, and optionally a logo image committed to the app repo.
--
-- The brand colour is an identity accent ONLY — it colours the wordmark and
-- brand badges. Buttons stay ink, positive stays teal, warnings stay amber,
-- and errors stay red for every business: in an analytics tool red means
-- bad (spec §4.1), and that meaning cannot vary by brand.

alter table businesses
  add column brand_color     text not null default '#D31C1D',
  add column wordmark        text,
  add column wordmark_accent text,
  add column tagline         text,
  add column logo_path       text;

alter table businesses add constraint businesses_brand_color_hex
  check (brand_color ~ '^#[0-9A-Fa-f]{6}$');

update businesses
   set wordmark = 'inStyle', wordmark_accent = 'Style', tagline = 'salon'
 where code = 'SALON';
