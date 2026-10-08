-- Struk digital (QR): pencarian token → order tanpa memindai tabel event.
create index event_receipt_token on event ((payload->>'token')) where type = 'receipt.digital';
-- Struk menyusun semua event satu order; id order unik per perangkat (deviceId-nomor).
create index event_order_ref on event (outlet_id, (payload->>'orderId'));
