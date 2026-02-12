.PHONY: up down logs up-dev down-dev logs-dev up-deploy down-deploy logs-deploy backend-run backend-test frontend-dev

up: up-dev

down: down-dev

logs: logs-dev

up-dev:
	cd deploy && docker compose -f docker-compose.dev.yml --env-file .env.dev up --build

down-dev:
	cd deploy && docker compose -f docker-compose.dev.yml --env-file .env.dev down

logs-dev:
	cd deploy && docker compose -f docker-compose.dev.yml --env-file .env.dev logs -f

up-deploy:
	cd deploy && docker compose -f docker-compose.yml --env-file .env.deploy up -d

down-deploy:
	cd deploy && docker compose -f docker-compose.yml --env-file .env.deploy down

logs-deploy:
	cd deploy && docker compose -f docker-compose.yml --env-file .env.deploy logs -f

backend-run:
	cd backend && go run ./cmd/sonarscope-api

backend-test:
	cd backend && GOCACHE=/tmp/sonarscope-gocache GOMODCACHE=/tmp/sonarscope-gomodcache go test ./...

frontend-dev:
	cd frontend && npm run dev
