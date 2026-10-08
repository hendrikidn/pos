-- Service charge dan pembulatan total per outlet. Bawaan = perilaku lama (tanpa service charge, tanpa pembulatan, pajak atas service).
alter table outlet
  add column service_charge_percent integer not null default 0 check (service_charge_percent between 0 and 30),
  add column tax_on_service boolean not null default true,
  add column rounding_unit integer not null default 0 check (rounding_unit in (0, 100, 500, 1000));
