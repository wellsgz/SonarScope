package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"sonarscope/backend/internal/api"
	"sonarscope/backend/internal/config"
	"sonarscope/backend/internal/db"
	"sonarscope/backend/internal/model"
	"sonarscope/backend/internal/probe"
	"sonarscope/backend/internal/store"
	"sonarscope/backend/internal/telemetry"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	migrationsDir := os.Getenv("MIGRATIONS_DIR")
	if migrationsDir == "" {
		migrationsDir = "migrations"
	}
	if err := db.ApplyMigrations(ctx, pool, migrationsDir); err != nil {
		log.Fatalf("apply migrations: %v", err)
	}

	st := store.New(pool)
	defaults := model.Settings{
		PingIntervalSec: cfg.DefaultInterval,
		ICMPPayloadSize: cfg.DefaultPayload,
		AutoRefreshSec:  cfg.DefaultRefresh,
	}
	if err := st.EnsureDefaultSettings(ctx, defaults); err != nil {
		log.Fatalf("seed settings: %v", err)
	}

	settings, err := st.GetSettings(ctx)
	if err != nil {
		log.Printf("failed to load settings, using defaults: %v", err)
		settings = defaults
	}

	hub := telemetry.NewHub()
	probeEngine := probe.NewEngine(st, hub, cfg.ProbeWorkers, time.Duration(cfg.PingTimeoutSec)*time.Second, settings)
	apiServer := api.NewServer(cfg, st, probeEngine, hub)

	httpServer := &http.Server{
		Addr:         cfg.HTTPAddr,
		Handler:      apiServer.Routes(),
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  90 * time.Second,
	}

	go func() {
		log.Printf("SonarScope API listening on %s", cfg.HTTPAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen and serve: %v", err)
		}
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGTERM, syscall.SIGINT)
	<-signalCh

	probeEngine.Stop()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
}
