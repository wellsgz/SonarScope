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
	PortType    string    `json:"port_type"`
	Description string    `json:"description"`
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
	PortType               string     `json:"port_type"`
	Groups                 []string   `json:"group"`
	EndpointID             int64      `json:"endpoint_id"`
}

type MonitorEndpointsPageResponse struct {
	Items       []MonitorEndpoint `json:"items"`
	Page        int               `json:"page"`
	PageSize    int               `json:"page_size"`
	TotalItems  int64             `json:"total_items"`
	TotalPages  int               `json:"total_pages"`
	SortBy      string            `json:"sort_by,omitempty"`
	SortDir     string            `json:"sort_dir,omitempty"`
	StatsScope  string            `json:"stats_scope,omitempty"`
	RangeRollup string            `json:"range_rollup,omitempty"`
}

type InventoryEndpointView struct {
	EndpointID  int64     `json:"endpoint_id"`
	Hostname    string    `json:"hostname"`
	IPAddress   string    `json:"ip_address"`
	MACAddress  string    `json:"mac_address"`
	VLAN        string    `json:"vlan"`
	Switch      string    `json:"switch"`
	Port        string    `json:"port"`
	PortType    string    `json:"port_type"`
	Description string    `json:"description"`
	Groups      []string  `json:"group"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type InventoryEndpointUpdate struct {
	Hostname    string `json:"hostname"`
	MACAddress  string `json:"mac_address"`
	VLAN        string `json:"vlan"`
	Switch      string `json:"switch"`
	Port        string `json:"port"`
	PortType    string `json:"port_type"`
	Description string `json:"description"`
}

type InventoryEndpointCreate struct {
	IPAddress   string `json:"ip_address"`
	Hostname    string `json:"hostname"`
	MACAddress  string `json:"mac_address"`
	VLAN        string `json:"vlan"`
	Switch      string `json:"switch"`
	Port        string `json:"port"`
	PortType    string `json:"port_type"`
	Description string `json:"description"`
}

type Group struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	IsSystem    bool      `json:"is_system"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	EndpointIDs []int64   `json:"endpoint_ids,omitempty"`
}

type Settings struct {
	PingIntervalSec int `json:"ping_interval_sec"`
	ICMPPayloadSize int `json:"icmp_payload_bytes"`
	ICMPTimeoutMs   int `json:"icmp_timeout_ms"`
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
	PortType    string               `json:"port_type"`
	Description string               `json:"description"`
	Sorting     string               `json:"sorting"`
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

type ImportApplySelection struct {
	RowID  string               `json:"row_id"`
	Action ImportClassification `json:"action"`
}

type ImportGroupAssignmentMode string

const (
	ImportGroupAssignmentNone     ImportGroupAssignmentMode = "none"
	ImportGroupAssignmentExisting ImportGroupAssignmentMode = "existing"
	ImportGroupAssignmentCreate   ImportGroupAssignmentMode = "create"
)

type ImportGroupAssignmentRequest struct {
	Mode      ImportGroupAssignmentMode `json:"mode"`
	GroupID   int64                     `json:"group_id,omitempty"`
	GroupName string                    `json:"group_name,omitempty"`
}

type ImportApplyRequest struct {
	PreviewID       string                        `json:"preview_id"`
	Selections      []ImportApplySelection        `json:"selections"`
	GroupAssignment *ImportGroupAssignmentRequest `json:"group_assignment,omitempty"`
}

type ImportGroupAssignmentResult struct {
	Applied            bool   `json:"applied"`
	GroupID            int64  `json:"group_id"`
	GroupName          string `json:"group_name"`
	ValidUploadIPs     int    `json:"valid_upload_ips"`
	ResolvedEndpoints  int    `json:"resolved_endpoints"`
	AssignedAdded      int    `json:"assigned_added"`
	UnresolvedIPs      int    `json:"unresolved_ips"`
	UsedExistingByName bool   `json:"used_existing_by_name,omitempty"`
}

type ImportApplyResponse struct {
	Added           int                          `json:"added"`
	Updated         int                          `json:"updated"`
	Errors          []string                     `json:"errors"`
	GroupAssignment *ImportGroupAssignmentResult `json:"group_assignment,omitempty"`
}

type DeleteInventoryByGroupResponse struct {
	Deleted      bool  `json:"deleted"`
	MatchedCount int64 `json:"matched_count"`
	DeletedCount int64 `json:"deleted_count"`
	GroupID      int64 `json:"group_id"`
}

type DeleteAllInventoryRequest struct {
	ConfirmPhrase string `json:"confirm_phrase"`
}

type DeleteAllInventoryResponse struct {
	Deleted      bool  `json:"deleted"`
	DeletedCount int64 `json:"deleted_count"`
}

type InventoryDeleteJobMode string

const (
	InventoryDeleteJobModeByGroup InventoryDeleteJobMode = "by_group"
	InventoryDeleteJobModeAll     InventoryDeleteJobMode = "all"
)

type InventoryDeleteJobState string

const (
	InventoryDeleteJobStateRunning   InventoryDeleteJobState = "running"
	InventoryDeleteJobStateCompleted InventoryDeleteJobState = "completed"
	InventoryDeleteJobStateFailed    InventoryDeleteJobState = "failed"
)

type InventoryDeleteJobAllRequest struct {
	ConfirmPhrase string `json:"confirm_phrase"`
}

type InventoryDeleteJobStatusResponse struct {
	Active             bool                    `json:"active"`
	JobID              string                  `json:"job_id,omitempty"`
	Mode               InventoryDeleteJobMode  `json:"mode,omitempty"`
	GroupID            *int64                  `json:"group_id,omitempty"`
	State              InventoryDeleteJobState `json:"state,omitempty"`
	MatchedEndpoints   int64                   `json:"matched_endpoints"`
	ProcessedEndpoints int64                   `json:"processed_endpoints"`
	DeletedEndpoints   int64                   `json:"deleted_endpoints"`
	ProgressPct        float64                 `json:"progress_pct"`
	EtaSeconds         *int64                  `json:"eta_seconds,omitempty"`
	Phase              string                  `json:"phase,omitempty"`
	Error              string                  `json:"error,omitempty"`
	StartedAt          *time.Time              `json:"started_at,omitempty"`
	UpdatedAt          *time.Time              `json:"updated_at,omitempty"`
	CompletedAt        *time.Time              `json:"completed_at,omitempty"`
}

type InventoryDeleteJobStartResponse struct {
	InventoryDeleteJobStatusResponse
}
