ALTER TABLE inventory_endpoint
ADD COLUMN IF NOT EXISTS port_type TEXT NOT NULL DEFAULT '';

ALTER MATERIALIZED VIEW IF EXISTS ping_1m
SET (timescaledb.materialized_only = false);

ALTER MATERIALIZED VIEW IF EXISTS ping_1h
SET (timescaledb.materialized_only = false);
