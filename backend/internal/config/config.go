package config

import (
	"fmt"
	"os"
	"strconv"
)

// Config holds runtime settings for the API and probe engine.
type Config struct {
	AppEnv           string
	HTTPAddr         string
	DatabaseURL      string
	ProbeWorkers     int
	DefaultInterval  int
	DefaultPayload   int
	DefaultTimeoutMs int
	DefaultRefresh   int
	AllowedOrigins   []string
}

func Load() (Config, error) {
	defaultTimeoutMs := 500
	if timeoutMs, ok := getEnvIntWithPresence("DEFAULT_ICMP_TIMEOUT_MS"); ok {
		defaultTimeoutMs = timeoutMs
	} else if legacyTimeoutSec, ok := getEnvIntWithPresence("PING_TIMEOUT_SEC"); ok {
		defaultTimeoutMs = legacyTimeoutSec * 1000
	}

	cfg := Config{
		AppEnv:           getEnv("APP_ENV", "development"),
		HTTPAddr:         getEnv("HTTP_ADDR", ":8080"),
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://sonarscope:sonarscope@localhost:5432/sonarscope?sslmode=disable"),
		ProbeWorkers:     getEnvInt("PROBE_WORKERS", 256),
		DefaultInterval:  getEnvInt("DEFAULT_PING_INTERVAL_SEC", 1),
		DefaultPayload:   getEnvInt("DEFAULT_ICMP_PAYLOAD_BYTES", 56),
		DefaultTimeoutMs: clampInt(defaultTimeoutMs, 20, 1000),
		DefaultRefresh:   getEnvInt("DEFAULT_AUTO_REFRESH_SEC", 10),
	}

	origins := getEnv("CORS_ALLOWED_ORIGINS", "http://localhost:5173")
	for _, origin := range splitCSV(origins) {
		if origin != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, origin)
		}
	}

	if cfg.ProbeWorkers < 1 {
		return Config{}, fmt.Errorf("PROBE_WORKERS must be >= 1")
	}
	if err := ValidateSettings(cfg.DefaultInterval, cfg.DefaultPayload, cfg.DefaultRefresh, cfg.DefaultTimeoutMs); err != nil {
		return Config{}, err
	}

	return cfg, nil
}

func ValidateSettings(intervalSec, payloadBytes, refreshSec, timeoutMs int) error {
	if intervalSec < 1 || intervalSec > 30 {
		return fmt.Errorf("ping_interval_sec must be between 1 and 30")
	}
	if payloadBytes < 8 || payloadBytes > 1400 {
		return fmt.Errorf("icmp_payload_bytes must be between 8 and 1400")
	}
	if timeoutMs < 20 || timeoutMs > 1000 {
		return fmt.Errorf("icmp_timeout_ms must be between 20 and 1000")
	}
	if refreshSec < 1 || refreshSec > 60 {
		return fmt.Errorf("auto_refresh_sec must be between 1 and 60")
	}
	return nil
}

func getEnv(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	value, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getEnvIntWithPresence(key string) (int, bool) {
	value, ok := os.LookupEnv(key)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func splitCSV(raw string) []string {
	items := []string{}
	start := 0
	for i := 0; i < len(raw); i++ {
		if raw[i] == ',' {
			items = append(items, trimSpace(raw[start:i]))
			start = i + 1
		}
	}
	items = append(items, trimSpace(raw[start:]))
	return items
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}

func clampInt(v, minValue, maxValue int) int {
	if v < minValue {
		return minValue
	}
	if v > maxValue {
		return maxValue
	}
	return v
}
