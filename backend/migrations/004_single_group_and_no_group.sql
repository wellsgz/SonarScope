ALTER TABLE group_def
ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
DECLARE
    v_no_group_id BIGINT;
BEGIN
    SELECT id
    INTO v_no_group_id
    FROM group_def
    WHERE lower(name) = 'no group'
    ORDER BY id
    LIMIT 1;

    IF v_no_group_id IS NULL THEN
        INSERT INTO group_def(name, description, is_system)
        VALUES ('no group', 'System default group for unassigned endpoints', TRUE)
        RETURNING id INTO v_no_group_id;
    ELSE
        UPDATE group_def
        SET is_system = TRUE,
            description = 'System default group for unassigned endpoints',
            updated_at = now()
        WHERE id = v_no_group_id;
    END IF;

    DELETE FROM group_member gm
    USING (
        SELECT endpoint_id
        FROM group_member
        GROUP BY endpoint_id
        HAVING COUNT(*) > 1
    ) conflicted
    WHERE gm.endpoint_id = conflicted.endpoint_id;

    INSERT INTO group_member(group_id, endpoint_id)
    SELECT v_no_group_id, ie.id
    FROM inventory_endpoint ie
    LEFT JOIN group_member gm ON gm.endpoint_id = ie.id
    WHERE gm.endpoint_id IS NULL
    ON CONFLICT DO NOTHING;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'group_member_endpoint_unique'
    ) THEN
        ALTER TABLE group_member
        ADD CONSTRAINT group_member_endpoint_unique UNIQUE (endpoint_id);
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION assign_inventory_endpoint_to_default_group()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_no_group_id BIGINT;
BEGIN
    SELECT id
    INTO v_no_group_id
    FROM group_def
    WHERE lower(name) = 'no group'
    ORDER BY id
    LIMIT 1;

    IF v_no_group_id IS NULL THEN
        RAISE EXCEPTION 'system group "no group" is missing';
    END IF;

    INSERT INTO group_member(group_id, endpoint_id)
    VALUES (v_no_group_id, NEW.id)
    ON CONFLICT (endpoint_id) DO NOTHING;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_inventory_endpoint_default_group ON inventory_endpoint;

CREATE TRIGGER trg_inventory_endpoint_default_group
AFTER INSERT ON inventory_endpoint
FOR EACH ROW
EXECUTE FUNCTION assign_inventory_endpoint_to_default_group();
