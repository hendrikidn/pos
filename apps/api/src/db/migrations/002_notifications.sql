-- Penerima notifikasi dan jejak pengiriman.

create table notification_recipient (
  id        bigserial primary key,
  tenant_id text not null references tenant (id),
  -- null = semua outlet milik tenant
  outlet_id text references outlet (id),
  user_id   text not null,
  role      text not null check (role in ('OWNER', 'OPS')),
  phone     text not null check (phone ~ '^[0-9]{8,15}$'),
  active    boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index notification_recipient_unique
  on notification_recipient (tenant_id, user_id, coalesce(outlet_id, ''), phone);

-- Satu insiden hanya dikirim sekali per penerima dan saluran.
create table notification_log (
  id          bigserial primary key,
  tenant_id   text not null references tenant (id),
  incident_id text not null references incident (id),
  user_id     text not null,
  channel     text not null,
  status      text not null check (status in ('SENT', 'FAILED')),
  error       text,
  sent_at     timestamptz not null default now()
);
create unique index notification_log_sent_once
  on notification_log (incident_id, user_id, channel) where status = 'SENT';

do $$
declare t text;
begin
  foreach t in array array['notification_recipient', 'notification_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) '
      'with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;

grant select, insert, update on notification_recipient to app_user;
grant select, insert on notification_log to app_user;
grant usage on all sequences in schema public to app_user;
