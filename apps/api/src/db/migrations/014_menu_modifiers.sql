-- Varian dan tambahan menu: daftar grup opsi (lihat packages/order/src/modifiers.ts). Kosong = menu polos.
alter table menu_item add column modifier_groups jsonb not null default '[]'::jsonb;
