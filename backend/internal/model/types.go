package model

import "time"

type ImportClassification string

const (
	ImportAdd       ImportClassification = "add"
	ImportUpdate    ImportClassification = "update"
	ImportUnchanged ImportClassification = "unchanged"
	ImportInvalid   ImportClassification = "invalid"
)

type InventoryEndpoint struct {
	ID          int64     `json:"id"`
	IP          string    `json:"ip"`
	MAC         string    `json:"mac"`
	VLAN        string    `json:"vlan"`
	SwitchName  string    `json:"switch"`
	Port        string    `json:"port"`
	Description string    `json:"description"`
	Status      string    `json:"status"`
	Zone        string    `json:"zone"`
	FWLB        string    `json:"fw_lb"`
	Hostname    string    `json:"hostname"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type EndpointStats struct {
	EndpointID             int64      `json:"endpoint_id"`
	LastFailedOn           *time.Time `json:"last_failed_on"`
	LastSuccessOn          *time.Time `json:"last_success_on"`
	SuccessCount           int64      `json:"success_count"`
	FailedCount            int64      `json:"failed_count"`
	ConsecutiveFailed      int64      `json:"consecutive_failed_count"`
	MaxConsecutiveFailed   int64      `json:"max_consecutive_failed_count"`
	MaxConsecutiveFailedAt *time.Time `json:"max_consecutive_failed_count_time"`
	FailedPct              float64    `json:"failed_pct"`
	TotalSentPing          int64      `json:"total_sent_ping"`
	LastPingStatus         string     `json:"last_ping_status"`
	LastPingLatencyMs      *float64   `json:"last_ping_latency_ms"`
	AverageLatencyMs       *float64   `json:"average_latency_ms"`
	ReplyIPAddress         *string    `json:"reply_ip_address"`
}

type MonitorEndpoint struct {
	Hostname               string     `json:"hostname"`
	LastFailedOn           *time.Time `json:"last_failed_on"`
	IPAddress              string     `json:"ip_address"`
	MACAddress             string     `json:"mac_address"`
	ReplyIPAddress         *string    `json:"reply_ip_address"`
	LastSuccessOn          *time.Time `json:"last_success_on"`
	SuccessCount           int64      `json:"success_count"`
	FailedCount            int64      `json:"failed_count"`
	ConsecutiveFailedCount int64      `json:"consecutive_failed_count"`
	MaxConsecutiveFailed   int64      `json:"max_consecutive_failed_count"`
	MaxConsecutiveFailedAt *time.Time `json:"max_consecutive_failed_count_time"`
	FailedPct              float64    `json:"failed_pct"`
	TotalSentPing          int64      `json:"total_sent_ping"`
	LastPingStatus         string     `json:"last_ping_status"`
	LastPingLatency        *float64   `json:"last_ping_latency"`
	AverageLatency         *float64   `json:"average_latency"`
	VLAN                   string     `json:"vlan"`
	Switch                 string     `json:"switch"`
	Port                   string     `json:"port"`
	Groups                 []string   `json:"group"`
	EndpointID             int64      `json:"endpoint_id"`
}

type Group struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	EndpointIDs []int64   `json:"endpoint_ids,omitempty"`
}

type Settings struct {
	PingIntervalSec int `json:"ping_interval_sec"`
	ICMPPayloadSize int `json:"icmp_payload_bytes"`
	AutoRefreshSec  int `json:"auto_refresh_sec"`
}

type TimeSeriesPoint struct {
	EndpointID   int64     `json:"endpoint_id"`
	Bucket       time.Time `json:"bucket"`
	LossRate     float64   `json:"loss_rate"`
	AvgLatencyMs *float64  `json:"avg_latency_ms"`
	MaxLatencyMs *float64  `json:"max_latency_ms"`
	SentCount    int64     `json:"sent_count"`
	FailCount    int64     `json:"fail_count"`
}

type PingResult struct {
	EndpointID    int64
	Timestamp     time.Time
	Success       bool
	LatencyMs     *float64
	ReplyIP       *string
	TTL           *int
	ErrorCode     string
	PayloadBytes  int
	IntervalSec   int
	RoundGroupIDs []int64
}

type ImportCandidate struct {
	RowID       string               `json:"row_id"`
	SourceRow   int                  `json:"source_row"`
	IP          string               `json:"ip"`
	MAC         string               `json:"mac"`
	VLAN        string               `json:"vlan"`
	SwitchName  string               `json:"switch"`
	Port        string               `json:"port"`
	Description string               `json:"description"`
	Status      string               `json:"status"`
	Zone        string               `json:"zone"`
	FWLB        string               `json:"fw_lb"`
	Sorting     string               `json:"sorting"`
	PortType    string               `json:"port_type"`
	Hostname    string               `json:"hostname"`
	Message     string               `json:"message"`
	Action      ImportClassification `json:"action"`
	ExistingID  *int64               `json:"existing_id,omitempty"`
}

type ImportPreview struct {
	PreviewID  string            `json:"preview_id"`
	CreatedAt  time.Time         `json:"created_at"`
	Candidates []ImportCandidate `json:"candidates"`
}
