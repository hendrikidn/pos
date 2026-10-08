-- Antrian meja (waitlist): tiket bernomor per outlet per hari, diambil pelanggan lewat halaman publik atau oleh kasir, dipanggil dan didudukkan
-- dari POS. Alamat publik memakai `web_slug` outlet (diatur di Toko Web); antrian punya sakelar sendiri.
alter table outlet add column queue_enabled boolean not null default false;

create table queue_ticket (
  id            bigserial primary key,
  tenant_id     text not null references tenant (id),
  outlet_id     text not null references outlet (id),
  day           text not null,
  seq           integer not null check (seq > 0),
  token         text not null unique,
  party_size    integer not null check (party_size between 1 and 20),
  name          text,
  phone         text,
  source        text not null check (source in ('SELF', 'STAFF')),
  status        text not null default 'WAITING' check (status in ('WAITING', 'CALLED', 'SEATED', 'NO_SHOW', 'CANCELED', 'EXPIRED')),
  created_at_ms float8 not null,
  created_by    text,
  caller_hash   text,
  called_at_ms  float8,
  call_count    integer not null default 0,
  called_by     text,
  -- melewati antrian: alasan dan tiket yang terlewati (R48)
  jump_reason   text,
  jump_note     text,
  jumped_over   jsonb,
  seated_at_ms  float8,
  seated_by     text,
  table_no      text,
  closed_by     text,
  closed_at_ms  float8,
  closed_reason text
);
create unique index queue_ticket_seq on queue_ticket (outlet_id, day, seq);
create index queue_ticket_status on queue_ticket (outlet_id, day, status);

alter table queue_ticket enable row level security;
create policy tenant_isolation on queue_ticket using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update on queue_ticket to app_user;
grant usage on all sequences in schema public to app_user;
