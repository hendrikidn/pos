-- Konfigurasi outlet, staf (PIN berbentuk hash), dan menu, dikelola owner dan diunduh terminal POS.

alter table outlet
  add column merchant_name text,
  add column tax_percent   integer not null default 10 check (tax_percent between 0 and 100),
  -- [{"tid":"12345678","bank":"Mandiri","label":"EDC Mandiri"}]
  add column edcs          jsonb not null default '[]',
  -- null = kebijakan bawaan
  add column policy        jsonb;

create table staff (
  tenant_id      text not null references tenant (id),
  id             text not null,
  name           text not null,
  role           text not null check (role in ('CASHIER', 'SUPERVISOR', 'MANAGER', 'OWNER')),
  -- PBKDF2-HMAC-SHA256; PIN polos tidak pernah disimpan
  pin_salt       text not null,
  pin_hash       text not null,
  pin_iterations integer not null check (pin_iterations >= 1000),
  -- null = bertugas di semua outlet
  outlet_ids     jsonb,
  active         boolean not null default true,
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table menu_item (
  tenant_id  text not null references tenant (id),
  id         text not null,
  -- null = tersedia di semua outlet
  outlet_id  text references outlet (id),
  name       text not null,
  price      integer not null check (price >= 0),
  category   text not null,
  sort       integer not null default 0,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- Catatan perubahan konfigurasi; append-only.
create table audit_log (
  id        bigserial primary key,
  tenant_id text not null references tenant (id),
  actor     text not null,
  action    text not null,
  detail    jsonb not null default '{}',
  at        timestamptz not null default now()
);
create trigger audit_no_update before update or delete on audit_log
  for each row execute function reject_mutation();

do $$
declare t text;
begin
  foreach t in array array['staff', 'menu_item', 'audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert, update on staff, menu_item to app_user;
grant select, insert on audit_log to app_user;
grant update on outlet to app_user;
grant usage on all sequences in schema public to app_user;
