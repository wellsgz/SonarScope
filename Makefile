.PHONY: up down logs backend-run backend-test frontend-dev

up:
	cd deploy && docker compose --env-file .env up --build

down:
	cd deploy && docker compose --env-file .env down

logs:
	cd deploy && docker compose --env-file .env logs -f

backend-run:
	cd backend && go run ./cmd/sonarscope-api

backend-test:
	cd backend && GOCACHE=/tmp/sonarscope-gocache GOMODCACHE=/tmp/sonarscope-gomodcache go test ./...

frontend-dev:
	cd frontend && npm run dev
