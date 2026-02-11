CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS inventory_endpoint (
    id BIGSERIAL PRIMARY KEY,
    ip INET NOT NULL UNIQUE,
    mac TEXT NOT NULL DEFAULT '',
    vlan TEXT NOT NULL DEFAULT '',
    switch_name TEXT NOT NULL DEFAULT '',
    port TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT '',
    fw_lb TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_vlan ON inventory_endpoint(vlan);
CREATE INDEX IF NOT EXISTS idx_inventory_switch_port ON inventory_endpoint(switch_name, port);

CREATE TABLE IF NOT EXISTS group_def (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_member (
    group_id BIGINT NOT NULL REFERENCES group_def(id) ON DELETE CASCADE,
    endpoint_id BIGINT NOT NULL REFERENCES inventory_endpoint(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (group_id, endpoint_id)
);

CREATE INDEX IF NOT EXISTS idx_group_member_endpoint ON group_member(endpoint_id);

CREATE TABLE IF NOT EXISTS app_settings (
    id BOOLEAN PRIMARY KEY DEFAULT TRUE,
    ping_interval_sec INT NOT NULL,
    icmp_payload_bytes INT NOT NULL,
    auto_refresh_sec INT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ping_interval_sec BETWEEN 1 AND 30),
    CHECK (icmp_payload_bytes BETWEEN 8 AND 1400),
    CHECK (auto_refresh_sec BETWEEN 1 AND 60)
);

INSERT INTO app_settings(id, ping_interval_sec, icmp_payload_bytes, auto_refresh_sec)
VALUES (TRUE, 1, 56, 30)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ping_raw (
    ts TIMESTAMPTZ NOT NULL,
    endpoint_id BIGINT NOT NULL REFERENCES inventory_endpoint(id) ON DELETE CASCADE,
    success BOOLEAN NOT NULL,
    latency_ms DOUBLE PRECISION,
    reply_ip INET,
    ttl INT,
    error_code TEXT NOT NULL DEFAULT '',
    payload_bytes INT NOT NULL,
    PRIMARY KEY (ts, endpoint_id)
);

SELECT create_hypertable('ping_raw', 'ts', if_not_exists => TRUE);

ALTER TABLE ping_raw SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'endpoint_id',
    timescaledb.compress_orderby = 'ts DESC'
);

CREATE INDEX IF NOT EXISTS idx_ping_raw_endpoint_ts ON ping_raw(endpoint_id, ts DESC);

CREATE TABLE IF NOT EXISTS endpoint_stats_current (
    endpoint_id BIGINT PRIMARY KEY REFERENCES inventory_endpoint(id) ON DELETE CASCADE,
    last_failed_on TIMESTAMPTZ,
    last_success_on TIMESTAMPTZ,
    success_count BIGINT NOT NULL DEFAULT 0,
    failed_count BIGINT NOT NULL DEFAULT 0,
    consecutive_failed_count BIGINT NOT NULL DEFAULT 0,
    max_consecutive_failed_count BIGINT NOT NULL DEFAULT 0,
    max_consecutive_failed_count_time TIMESTAMPTZ,
    failed_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_sent_ping BIGINT NOT NULL DEFAULT 0,
    last_ping_status TEXT NOT NULL DEFAULT 'unknown',
    last_ping_latency DOUBLE PRECISION,
    average_latency DOUBLE PRECISION,
    reply_ip_address INET,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE MATERIALIZED VIEW IF NOT EXISTS ping_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 minute', ts) AS bucket,
    endpoint_id,
    COUNT(*)::BIGINT AS sent_count,
    COUNT(*) FILTER (WHERE NOT success)::BIGINT AS fail_count,
    (COUNT(*) FILTER (WHERE NOT success)::DOUBLE PRECISION / NULLIF(COUNT(*), 0)::DOUBLE PRECISION) * 100 AS loss_rate,
    AVG(latency_ms) FILTER (WHERE success) AS avg_latency_ms,
    MAX(latency_ms) FILTER (WHERE success) AS max_latency_ms
FROM ping_raw
GROUP BY bucket, endpoint_id
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS ping_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 hour', ts) AS bucket,
    endpoint_id,
    COUNT(*)::BIGINT AS sent_count,
    COUNT(*) FILTER (WHERE NOT success)::BIGINT AS fail_count,
    (COUNT(*) FILTER (WHERE NOT success)::DOUBLE PRECISION / NULLIF(COUNT(*), 0)::DOUBLE PRECISION) * 100 AS loss_rate,
    AVG(latency_ms) FILTER (WHERE success) AS avg_latency_ms,
    MAX(latency_ms) FILTER (WHERE success) AS max_latency_ms
FROM ping_raw
GROUP BY bucket, endpoint_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'ping_1m',
    start_offset => INTERVAL '7 days',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE
);

SELECT add_continuous_aggregate_policy(
    'ping_1h',
    start_offset => INTERVAL '90 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE
);

SELECT add_compression_policy('ping_raw', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('ping_raw', INTERVAL '30 days', if_not_exists => TRUE);
SELECT add_retention_policy('ping_1m', INTERVAL '12 months', if_not_exists => TRUE);
SELECT add_retention_policy('ping_1h', INTERVAL '24 months', if_not_exists => TRUE);
