-- Skema awal POS Guard.
-- Waktu epoch disimpan sebagai float8 (ms): muat persis di bawah 2^53 dan dikembalikan sebagai angka oleh pg maupun PGlite.
-- Isolasi tenant: RLS pada semua tabel data, dengan role non-pemilik `app_user` yang dipakai aplikasi.

do $$
begin
  if not exists (select from pg_roles where rolname = 'app_user') then
    create role app_user nologin;
  end if;
end $$;

create table tenant (
  id   text primary key,
  name text not null
);

create table outlet (
  id                 text primary key,
  tenant_id          text not null references tenant (id),
  name               text not null,
  utc_offset_minutes integer not null default 420,
  capabilities       jsonb not null default '{"sensor":true,"kds":false,"printerReportsStatus":true}',
  terminals          jsonb not null default '[]'
);

create table device (
  id           text primary key,
  tenant_id    text not null references tenant (id),
  outlet_id    text not null references outlet (id),
  kind         text not null check (kind in ('terminal', 'sensor', 'kds')),
  token_hash   text not null unique,
  last_seq     integer not null default 0,
  last_hash    text not null default repeat('0', 64),
  last_seen_ms float8
);

create table api_token (
  token_hash text primary key,
  tenant_id  text not null references tenant (id),
  user_id    text not null,
  role       text not null check (role in ('OWNER', 'OPS', 'MANAGER', 'SUPERVISOR')),
  label      text
);

-- Log event: append-only (trigger di bawah menolak UPDATE, DELETE, dan TRUNCATE).
create table event (
  id              text not null,
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  device_id       text not null references device (id),
  seq             integer not null,
  type            text not null,
  device_time_ms  float8 not null,
  clock_offset_ms float8 not null default 0,
  actor_id        text,
  prev_hash       text not null,
  hash            text not null,
  payload         jsonb not null,
  integrity       text,
  server_time     timestamptz not null default now(),
  primary key (device_id, seq)
);
create index event_outlet_time on event (outlet_id, device_time_ms);

create function reject_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'tabel % bersifat append-only', tg_table_name;
end $$;

create trigger event_no_update before update or delete on event
  for each row execute function reject_mutation();
create trigger event_no_truncate before truncate on event
  for each statement execute function reject_mutation();

create table integrity_issue (
  id        bigserial primary key,
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  device_id text not null,
  seq       integer,
  kind      text not null,
  detail    text not null,
  at        timestamptz not null default now()
);

create table bank_report (
  id              bigserial primary key,
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  bank            text not null,
  filename        text,
  uploaded_by     text not null,
  uploaded_at     timestamptz not null default now(),
  txn_count       integer not null,
  coverage_end_ms float8,
  errors          jsonb not null default '[]'
);

create table bank_txn (
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  key       text not null,
  report_id bigint not null references bank_report (id),
  txn_ms    float8,
  data      jsonb not null,
  primary key (outlet_id, key)
);

create table bank_coverage (
  tenant_id       text not null references tenant (id),
  outlet_id       text not null references outlet (id),
  tid             text not null,
  coverage_end_ms float8 not null,
  primary key (outlet_id, tid)
);

create table bank_finding (
  tenant_id text not null references tenant (id),
  outlet_id text not null references outlet (id),
  hit_key   text not null,
  at_ms     float8 not null,
  hit       jsonb not null,
  primary key (outlet_id, hit_key)
);

create table incident (
  id         text primary key,
  tenant_id  text not null references tenant (id),
  outlet_id  text not null references outlet (id),
  terminal_id text,
  start_ms   float8 not null,
  end_ms     float8 not null,
  score      integer not null,
  level      text not null check (level in ('LOW', 'MEDIUM', 'CRITICAL')),
  multiplier float8 not null,
  order_ids  jsonb not null,
  actor_ids  jsonb not null,
  hits       jsonb not null,
  status     text not null default 'OPEN'
             check (status in ('OPEN', 'RETRACTED', 'CONFIRMED_FRAUD', 'LEGIT', 'FALSE_ALARM', 'INCONCLUSIVE')),
  first_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index incident_outlet on incident (outlet_id, start_ms);

create table incident_review (
  id          bigserial primary key,
  tenant_id   text not null references tenant (id),
  incident_id text not null references incident (id),
  reviewer    text not null,
  label       text not null,
  note        text,
  reviewed_at timestamptz not null default now()
);

-- Isolasi tenant: app_user hanya melihat baris tenant yang diset lewat app.tenant_id.
do $$
declare t text;
begin
  foreach t in array array[
    'outlet', 'device', 'event', 'integrity_issue', 'bank_report', 'bank_txn',
    'bank_coverage', 'bank_finding', 'incident', 'incident_review'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select on outlet to app_user;
grant select, update on device to app_user;
grant select, insert on event, integrity_issue, incident_review to app_user;
grant select, insert, update, delete on bank_report, bank_txn, bank_coverage, bank_finding, incident to app_user;
grant usage on all sequences in schema public to app_user;
