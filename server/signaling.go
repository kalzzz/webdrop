package server

import (
	"net/http"
	"strings"
)

// shortPlatform extracts a human-readable platform name from a full userAgent string.
// PC hostname cannot be obtained from the browser, so we use UserAgent for platform labels.
func shortPlatform(ua string) string {
	if ua == "" {
		return "Unknown"
	}
	// Mobile devices: use a tidy platform label.
	if strings.Contains(ua, "iPhone") {
		return "iPhone"
	}
	if strings.Contains(ua, "iPad") {
		return "iPad"
	}
	if strings.Contains(ua, "Android") {
		return "Android"
	}
	// PC / desktop: derive from OS in UserAgent.
	if strings.Contains(ua, "Windows") {
		return "Windows PC"
	}
	if strings.Contains(ua, "Mac") && !strings.Contains(ua, "iPhone") {
		return "Mac"
	}
	if strings.Contains(ua, "Linux") && !strings.Contains(ua, "Android") {
		return "Linux PC"
	}
	// Generic browser name fallback.
	if strings.Contains(ua, "Chrome") && !strings.Contains(ua, "Edg/") {
		return "Chrome Browser"
	}
	if strings.Contains(ua, "Safari") && !strings.Contains(ua, "Chrome") && !strings.Contains(ua, "Edg/") {
		return "Safari Browser"
	}
	if strings.Contains(ua, "Firefox") && !strings.Contains(ua, "Chrome") {
		return "Firefox Browser"
	}
	if strings.Contains(ua, "Edg/") || strings.Contains(ua, "Edge") {
		return "Edge Browser"
	}
	// Last resort: first token of UA.
	for i, ch := range ua {
		if ch == ' ' || ch == '/' {
			return ua[:i]
		}
	}
	return ua
}

// package-level singleton DeviceHub for WebSocket connections.
var deviceHub = newDeviceHubSingleton()

func newDeviceHubSingleton() *DeviceHub {
	hub := NewDeviceHub()
	go hub.Run()
	return hub
}

// WSHandler returns the shared http.HandlerFunc for WebSocket connections.
func WSHandler() http.Handler {
	return deviceHub.WSHandler()
}
