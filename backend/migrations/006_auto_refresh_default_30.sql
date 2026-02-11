UPDATE app_settings
SET auto_refresh_sec = 30,
    updated_at = now()
WHERE id = TRUE
  AND auto_refresh_sec = 10;
