-- Reservasi meja dengan uang muka (deposit). Uang muka dicatat di sini; pemakaiannya sebagai pembayaran adalah event `payment.received`
-- dengan metode DEPOSIT dan `reservationId`, jadi jumlah terpakai dihitung dari event (bukan kolom yang bisa diubah).
create table reservation (
  id              bigserial primary key,
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  guest_name      text not null,
  phone           text,
  party_size      integer not null check (party_size between 1 and 50),
  start_ms        float8 not null,
  duration_min    integer not null default 90 check (duration_min between 30 and 480),
  table_no        text,
  status          text not null default 'BOOKED' check (status in ('BOOKED', 'SEATED', 'NO_SHOW', 'CANCELED')),
  note            text,
  created_by      text not null,
  created_at      timestamptz not null default now(),
  status_by       text,
  status_at_ms    float8,
  status_reason   text,
  deposit         bigint not null default 0 check (deposit >= 0),
  deposit_method  text check (deposit_method in ('CASH', 'TRANSFER')),
  deposit_by      text,
  deposit_at_ms   float8,
  settle_kind     text check (settle_kind in ('REFUND', 'FORFEIT')),
  settle_amount   bigint check (settle_amount > 0),
  settle_by       text,
  settle_at_ms    float8,
  settle_reason   text
);
create index reservation_outlet_time on reservation (outlet_id, start_ms);

alter table reservation enable row level security;
create policy tenant_isolation on reservation using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

grant select, insert, update on reservation to app_user;
grant usage on all sequences in schema public to app_user;
