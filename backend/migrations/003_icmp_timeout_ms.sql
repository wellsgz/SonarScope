ALTER TABLE app_settings
ADD COLUMN IF NOT EXISTS icmp_timeout_ms INT NOT NULL DEFAULT 500;

UPDATE app_settings
SET icmp_timeout_ms = GREATEST(20, LEAST(1000, COALESCE(icmp_timeout_ms, 500)));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'app_settings_icmp_timeout_ms_check'
    ) THEN
        ALTER TABLE app_settings
        ADD CONSTRAINT app_settings_icmp_timeout_ms_check CHECK (icmp_timeout_ms BETWEEN 20 AND 1000);
    END IF;
END
$$;
