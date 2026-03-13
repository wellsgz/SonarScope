package api

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"sonarscope/backend/internal/model"
	"sonarscope/backend/internal/util"
)

type inventoryBatchGroupTargetResolution struct {
	GroupID            *int64
	GroupName          string
	UsedExistingByName bool
}

func normalizeInventoryBatchMatchSpec(spec model.InventoryBatchMatchSpec) model.InventoryBatchMatchSpec {
	spec.Regex = strings.TrimSpace(spec.Regex)
	spec.IPs = uniqueStrings(spec.IPs)
	return spec
}

func validateInventoryBatchMatchSpec(spec model.InventoryBatchMatchSpec) error {
	switch spec.Mode {
	case model.InventoryBatchMatchModeCriteria:
		if spec.Regex == "" {
			return errors.New("regex is required for criteria mode")
		}
		if _, err := regexp.Compile(spec.Regex); err != nil {
			return fmt.Errorf("invalid regex: %w", err)
		}
		switch spec.Field {
		case model.InventoryBatchMatchFieldHostname,
			model.InventoryBatchMatchFieldIPAddress,
			model.InventoryBatchMatchFieldMACAddress,
			model.InventoryBatchMatchFieldVLAN,
			model.InventoryBatchMatchFieldSwitch,
			model.InventoryBatchMatchFieldPort,
			model.InventoryBatchMatchFieldPortType,
			model.InventoryBatchMatchFieldDescription,
			model.InventoryBatchMatchFieldCustom1,
			model.InventoryBatchMatchFieldCustom2,
			model.InventoryBatchMatchFieldCustom3:
			return nil
		default:
			return fmt.Errorf("unsupported match field %q", spec.Field)
		}
	case model.InventoryBatchMatchModeIPList:
		if len(spec.IPs) == 0 {
			return errors.New("at least one IP is required for IP list mode")
		}
		return nil
	default:
		return fmt.Errorf("unsupported match mode %q", spec.Mode)
	}
}

func inventoryBatchFieldLabel(field model.InventoryBatchMatchField) string {
	switch field {
	case model.InventoryBatchMatchFieldHostname:
		return "Hostname"
	case model.InventoryBatchMatchFieldIPAddress:
		return "IP Address"
	case model.InventoryBatchMatchFieldMACAddress:
		return "MAC Address"
	case model.InventoryBatchMatchFieldVLAN:
		return "VLAN"
	case model.InventoryBatchMatchFieldSwitch:
		return "Switch"
	case model.InventoryBatchMatchFieldPort:
		return "Port"
	case model.InventoryBatchMatchFieldPortType:
		return "Port Type"
	case model.InventoryBatchMatchFieldDescription:
		return "Description"
	case model.InventoryBatchMatchFieldCustom1:
		return "Custom Field 1"
	case model.InventoryBatchMatchFieldCustom2:
		return "Custom Field 2"
	case model.InventoryBatchMatchFieldCustom3:
		return "Custom Field 3"
	default:
		return string(field)
	}
}

func buildInventoryBatchTargetSummary(spec model.InventoryBatchMatchSpec, stats model.InventoryBatchMatchStats) string {
	switch spec.Mode {
	case model.InventoryBatchMatchModeCriteria:
		return fmt.Sprintf(`Regex match on %s: /%s/i`, inventoryBatchFieldLabel(spec.Field), spec.Regex)
	case model.InventoryBatchMatchModeIPList:
		if stats.UniqueCount > 0 {
			return fmt.Sprintf("IP list match (%d matched of %d unique)", stats.MatchedCount, stats.UniqueCount)
		}
		return fmt.Sprintf("IP list match (%d matched)", stats.MatchedCount)
	default:
		return "Matched endpoints"
	}
}

func (s *Server) buildInventoryBatchPreview(
	r *http.Request,
	spec model.InventoryBatchMatchSpec,
) (model.InventoryBatchMatchPreview, error) {
	stats, endpointIDs, err := s.store.ResolveInventoryBatchMatch(r.Context(), spec)
	if err != nil {
		return model.InventoryBatchMatchPreview{}, err
	}
	sample, err := s.store.ListInventoryEndpointsByIDs(r.Context(), endpointIDs, 50)
	if err != nil {
		return model.InventoryBatchMatchPreview{}, err
	}
	return model.InventoryBatchMatchPreview{
		Stats:       stats,
		EndpointIDs: endpointIDs,
		Sample:      sample,
	}, nil
}

func (s *Server) resolveInventoryBatchGroupTarget(
	r *http.Request,
	target model.InventoryBatchGroupAssignmentTarget,
) (inventoryBatchGroupTargetResolution, error) {
	switch target.Mode {
	case model.InventoryBatchGroupAssignmentExisting:
		if target.GroupID < 1 || strings.TrimSpace(target.GroupName) != "" {
			return inventoryBatchGroupTargetResolution{}, errors.New("invalid target for existing mode")
		}
		group, err := s.store.GetGroupByID(r.Context(), target.GroupID)
		if err != nil {
			return inventoryBatchGroupTargetResolution{}, err
		}
		if group.IsSystem {
			return inventoryBatchGroupTargetResolution{}, errors.New(`system group "no group" cannot be targeted`)
		}
		groupID := group.ID
		return inventoryBatchGroupTargetResolution{
			GroupID:   &groupID,
			GroupName: group.Name,
		}, nil
	case model.InventoryBatchGroupAssignmentCreate:
		if target.GroupID > 0 {
			return inventoryBatchGroupTargetResolution{}, errors.New("invalid target for create mode")
		}
		groupName := strings.TrimSpace(target.GroupName)
		if groupName == "" {
			return inventoryBatchGroupTargetResolution{}, errors.New("group_name is required for create mode")
		}
		if strings.EqualFold(groupName, "no group") {
			return inventoryBatchGroupTargetResolution{}, errors.New(`group name "no group" is reserved`)
		}
		group, err := s.store.GetGroupByNameCI(r.Context(), groupName)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return inventoryBatchGroupTargetResolution{}, err
		}
		if err == nil {
			if group.IsSystem {
				return inventoryBatchGroupTargetResolution{}, errors.New(`system group "no group" cannot be targeted`)
			}
			groupID := group.ID
			return inventoryBatchGroupTargetResolution{
				GroupID:            &groupID,
				GroupName:          group.Name,
				UsedExistingByName: true,
			}, nil
		}
		return inventoryBatchGroupTargetResolution{
			GroupName: groupName,
		}, nil
	default:
		return inventoryBatchGroupTargetResolution{}, fmt.Errorf("unsupported target mode %q", target.Mode)
	}
}

func (s *Server) ensureInventoryBatchGroup(
	r *http.Request,
	target inventoryBatchGroupTargetResolution,
) (inventoryBatchGroupTargetResolution, error) {
	if target.GroupID != nil {
		return target, nil
	}

	created, err := s.store.CreateGroup(r.Context(), target.GroupName, "", []int64{})
	if err != nil {
		existing, lookupErr := s.store.GetGroupByNameCI(r.Context(), target.GroupName)
		if lookupErr != nil {
			return inventoryBatchGroupTargetResolution{}, err
		}
		if existing.IsSystem {
			return inventoryBatchGroupTargetResolution{}, errors.New(`system group "no group" cannot be targeted`)
		}
		groupID := existing.ID
		return inventoryBatchGroupTargetResolution{
			GroupID:            &groupID,
			GroupName:          existing.Name,
			UsedExistingByName: true,
		}, nil
	}

	groupID := created.ID
	return inventoryBatchGroupTargetResolution{
		GroupID:   &groupID,
		GroupName: created.Name,
	}, nil
}

func (s *Server) handleInventoryBatchGroupPreview(w http.ResponseWriter, r *http.Request) {
	var req model.InventoryBatchGroupPreviewRequest
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	req.Match = normalizeInventoryBatchMatchSpec(req.Match)
	if err := validateInventoryBatchMatchSpec(req.Match); err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	target, err := s.resolveInventoryBatchGroupTarget(r, req.Target)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			util.WriteError(w, http.StatusNotFound, "group not found")
			return
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	preview, err := s.buildInventoryBatchPreview(r, req.Match)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	alreadyInGroup := int64(0)
	if target.GroupID != nil {
		alreadyInGroup, err = s.store.CountInventoryEndpointsInGroup(r.Context(), preview.EndpointIDs, *target.GroupID)
		if err != nil {
			util.WriteError(w, http.StatusInternalServerError, err.Error())
			return
		}
	}

	groupName := target.GroupName
	util.WriteJSON(w, http.StatusOK, model.InventoryBatchGroupPreviewResponse{
		Preview:            preview,
		GroupID:            target.GroupID,
		GroupName:          groupName,
		AlreadyInGroup:     int(alreadyInGroup),
		WouldAssign:        maxInt(0, len(preview.EndpointIDs)-int(alreadyInGroup)),
		UsedExistingByName: target.UsedExistingByName,
	})
}

func (s *Server) handleInventoryBatchGroupApply(w http.ResponseWriter, r *http.Request) {
	var req model.InventoryBatchGroupApplyRequest
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	target, err := s.resolveInventoryBatchGroupTarget(r, req.Target)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			util.WriteError(w, http.StatusNotFound, "group not found")
			return
		}
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	endpointIDs, err := s.store.ResolveExistingInventoryEndpointIDs(r.Context(), req.EndpointIDs)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(endpointIDs) == 0 {
		util.WriteError(w, http.StatusBadRequest, "no matched endpoints to assign")
		return
	}

	target, err = s.ensureInventoryBatchGroup(r, target)
	if err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	alreadyInGroup, err := s.store.CountInventoryEndpointsInGroup(r.Context(), endpointIDs, *target.GroupID)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	assignedAdded, err := s.store.AddEndpointsToGroup(r.Context(), *target.GroupID, endpointIDs)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	util.WriteJSON(w, http.StatusOK, model.InventoryBatchGroupApplyResponse{
		MatchedCount:       len(endpointIDs),
		GroupID:            *target.GroupID,
		GroupName:          target.GroupName,
		AlreadyInGroup:     int(alreadyInGroup),
		AssignedAdded:      int(assignedAdded),
		UsedExistingByName: target.UsedExistingByName,
	})
}

func (s *Server) handleInventoryBatchDeletePreview(w http.ResponseWriter, r *http.Request) {
	var req model.InventoryBatchDeletePreviewRequest
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	req.Match = normalizeInventoryBatchMatchSpec(req.Match)
	if err := validateInventoryBatchMatchSpec(req.Match); err != nil {
		util.WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	preview, err := s.buildInventoryBatchPreview(r, req.Match)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	util.WriteJSON(w, http.StatusOK, model.InventoryBatchDeletePreviewResponse{
		Preview:       preview,
		TargetSummary: buildInventoryBatchTargetSummary(req.Match, preview.Stats),
	})
}

func (s *Server) handleInventoryDeleteJobMatch(w http.ResponseWriter, r *http.Request) {
	var req model.InventoryDeleteJobMatchRequest
	if err := util.DecodeJSON(r, &req); err != nil {
		util.WriteError(w, http.StatusBadRequest, "invalid request payload")
		return
	}

	endpointIDs, err := s.store.ResolveExistingInventoryEndpointIDs(r.Context(), req.EndpointIDs)
	if err != nil {
		util.WriteError(w, http.StatusInternalServerError, err.Error())
		return
	}

	targetSummary := strings.TrimSpace(req.TargetSummary)
	if targetSummary == "" {
		targetSummary = "Matched endpoints"
	}

	job, err := s.beginDeleteJob(model.InventoryDeleteJobModeMatch, nil, targetSummary)
	if err != nil {
		util.WriteError(w, http.StatusConflict, err.Error())
		return
	}

	go s.runDeleteJob(job, endpointIDs)
	util.WriteJSON(w, http.StatusAccepted, s.deleteJobSnapshot())
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
