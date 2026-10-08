-- Langganan dan penagihan. Tenant tanpa baris `subscription` (pilot awal) tidak ditagih. Penulisan hanya lewat koneksi pemilik skema
-- (layanan penagihan dan konsol admin platform); owner tenant hanya membaca miliknya (RLS).
create table plan (
  id               text primary key,
  name             text not null,
  -- rupiah per outlet per bulan; harga awal hanya contoh, diatur admin platform
  price_per_outlet integer not null check (price_per_outlet >= 0),
  active           boolean not null default true
);
insert into plan (id, name, price_per_outlet) values ('standard', 'Standard', 199000);

create table subscription (
  tenant_id     text primary key references tenant (id),
  plan_id       text not null references plan (id),
  status        text not null check (status in ('TRIAL', 'ACTIVE', 'CANCELED')),
  -- hari terakhir masa uji coba (tanggal WIB, inklusif); periode berbayar pertama mulai keesokan harinya
  trial_end     text not null,
  created_at    timestamptz not null default now(),
  canceled_at   timestamptz
);

create sequence invoice_seq;
create table invoice (
  id           text primary key,
  tenant_id    text not null references tenant (id),
  period_start text not null,
  period_end   text not null,
  outlets      integer not null,
  unit_price   integer not null,
  amount       integer not null check (amount >= 0),
  status       text not null check (status in ('ISSUED', 'PAID', 'VOID')),
  issued_at    timestamptz not null default now(),
  due_date     text not null,
  paid_at      timestamptz,
  pay_method   text,
  pay_ref      text,
  note         text
);
-- Satu tagihan hidup per periode; yang dibatalkan boleh diterbitkan ulang.
create unique index invoice_period_live on invoice (tenant_id, period_start) where status <> 'VOID';
create index invoice_status on invoice (status, due_date);

alter table subscription enable row level security;
alter table invoice enable row level security;
create policy tenant_isolation on subscription using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
create policy tenant_isolation on invoice using (tenant_id = current_setting('app.tenant_id', true)) with check (tenant_id = current_setting('app.tenant_id', true));
grant select on subscription, invoice to app_user;
grant select on plan to app_user;
