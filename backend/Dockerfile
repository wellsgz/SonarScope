FROM golang:1.22-alpine AS builder
WORKDIR /src

RUN apk add --no-cache git ca-certificates

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/sonarscope-api ./cmd/sonarscope-api

FROM alpine:3.20
WORKDIR /app

RUN apk add --no-cache ca-certificates libcap

COPY --from=builder /out/sonarscope-api /app/sonarscope-api
COPY migrations /app/migrations

RUN setcap cap_net_raw+ep /app/sonarscope-api

EXPOSE 8080
ENV HTTP_ADDR=:8080
ENV MIGRATIONS_DIR=/app/migrations

ENTRYPOINT ["/app/sonarscope-api"]
