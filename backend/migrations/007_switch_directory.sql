CREATE TABLE IF NOT EXISTS switch_directory (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    ip_address INET NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
