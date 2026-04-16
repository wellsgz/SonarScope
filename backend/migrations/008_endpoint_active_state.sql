ALTER TABLE inventory_endpoint
ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_inventory_is_active ON inventory_endpoint(is_active);
