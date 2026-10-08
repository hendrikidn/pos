-- Penggajian dan koreksi absensi. Absen itu sendiri adalah event `attendance.clocked` dari terminal; tabel di sini hanya untuk tarif gaji,
-- koreksi manual (lupa absen), dan hasil penggajian per periode.
create table staff_pay (
  tenant_id           text not null,
  staff_id            text not null,
  pay_type            text not null check (pay_type in ('HOURLY', 'MONTHLY')),
  -- HOURLY: rupiah per jam; MONTHLY: gaji pokok per periode
  rate                integer not null check (rate >= 0),
  overtime_multiplier numeric(3, 1) not null default 1.5 check (overtime_multiplier between 1 and 3),
  primary key (tenant_id, staff_id),
  foreign key (tenant_id, staff_id) references staff (tenant_id, id)
);

create table attendance_adjust (
  id          bigserial primary key,
  tenant_id   text not null references tenant (id),
  outlet_id   text not null references outlet (id),
  staff_id    text not null,
  start_ms    float8 not null,
  end_ms      float8 not null check (end_ms > start_ms),
  reason      text not null,
  created_by  text not null,
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  void_reason text,
  foreign key (tenant_id, staff_id) references staff (tenant_id, id)
);
create index attendance_adjust_outlet on attendance_adjust (outlet_id, start_ms);

create table payroll_run (
  id                    bigserial primary key,
  tenant_id             text not null references tenant (id),
  outlet_id             text not null references outlet (id),
  period_start          text not null,
  period_end            text not null,
  status                text not null check (status in ('DRAFT', 'FINAL', 'PAID', 'CANCELED')),
  daily_regular_minutes integer not null default 480 check (daily_regular_minutes between 60 and 1440),
  created_by            text not null,
  created_at            timestamptz not null default now(),
  finalized_by          text,
  finalized_at          timestamptz,
  paid_date             text,
  pay_method            text check (pay_method in ('TUNAI', 'TRANSFER')),
  cancel_reason         text
);
create index payroll_run_outlet on payroll_run (outlet_id, period_start);

create table payroll_line (
  tenant_id       text not null,
  run_id          bigint not null references payroll_run (id),
  staff_id        text not null,
  staff_name      text not null,
  pay_type        text not null,
  rate            integer not null,
  regular_minutes integer not null,
  overtime_minutes integer not null,
  base            bigint not null,
  overtime_pay    bigint not null,
  allowance       bigint not null default 0 check (allowance >= 0),
  deduction       bigint not null default 0 check (deduction >= 0),
  net             bigint not null check (net >= 0),
  note            text,
  primary key (run_id, staff_id)
);

do $$
declare t text;
begin
  foreach t in array array['staff_pay', 'attendance_adjust', 'payroll_run', 'payroll_line'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert, update on staff_pay, attendance_adjust, payroll_run, payroll_line to app_user;
grant usage on all sequences in schema public to app_user;
