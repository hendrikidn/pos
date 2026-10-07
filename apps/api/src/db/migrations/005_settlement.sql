-- Slip settlement EDC (ringkasan batch) dan penandaan sumber temuan bank.

create table settlement_batch (
  tenant_id    text not null references tenant (id),
  outlet_id    text not null references outlet (id),
  tid          text not null,
  batch        text not null,
  bank         text not null,
  closed_at_ms float8 not null,
  summary      jsonb not null,
  -- hasil pembandingan dengan POS (per jenis pembayaran) dan catatan
  result       jsonb not null default '{}',
  uploaded_by  text not null,
  uploaded_at  timestamptz not null default now(),
  primary key (outlet_id, tid, batch)
);
create index settlement_batch_closed on settlement_batch (outlet_id, closed_at_ms);

alter table bank_finding add column source text not null default 'TXN' check (source in ('TXN', 'SETTLEMENT'));

alter table settlement_batch enable row level security;
create policy tenant_isolation on settlement_batch
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
grant select, insert, update, delete on settlement_batch to app_user;
