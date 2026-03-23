package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/skip2/go-qrcode"

	"webdrop/server"
	"webdrop/web"
)

func main() {
	port := 45680

	// Detect local IP address
	localIP := detectLocalIP()
	if localIP == "" {
		localIP = "127.0.0.1"
	}

	addr := fmt.Sprintf(":%d", port)
	url := fmt.Sprintf("http://%s:%d", localIP, port)

	// Generate QR code
	qr, err := qrcode.Encode(url, qrcode.Medium, 256)
	if err != nil {
		log.Printf("Failed to generate QR code: %v", err)
	} else {
		fmt.Println("\n╔══════════════════════════════════════════════════════════════╗")
		fmt.Println("║                      WebDrop Server                           ║")
		fmt.Println("╠══════════════════════════════════════════════════════════════╣")
		fmt.Printf("║  URL:   %-53s ║\n", url)
		fmt.Printf("║  Local: http://127.0.0.1:%d                                   ║\n", port)
		fmt.Println("╠══════════════════════════════════════════════════════════════╣")
		fmt.Println("║  QR Code:                                                    ║")
		printQR(qr)
		fmt.Println("╚══════════════════════════════════════════════════════════════╝")
		fmt.Println()
	}

	// Setup signal handling
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Create a single HTTP server handling both static files and WebSocket
	mux := http.NewServeMux()
	mux.Handle("/", web.NewHandler())
	mux.Handle("/ws", server.WSHandler())

	// Start combined HTTP+WebSocket server
	go func() {
		log.Printf("Starting server on %s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-sigChan
	log.Println("Shutting down...")
}

func detectLocalIP() string {
	// Try to find the best local IP address
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}

	var candidates []string

	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() && ipNet.IP.To4() != nil {
			ip := ipNet.IP.String()
			// Prefer 192.168.x.x or 10.x.x.x (typical LAN addresses)
			if len(ip) > 0 {
				candidates = append(candidates, ip)
			}
		}
	}

	// Return first non-loopback IPv4
	for _, ip := range candidates {
		return ip
	}

	return ""
}

func printQR(qr []byte) {
	// Print QR code line by line
	lines := len(qr) / 32 // QR code is square
	for i := 0; i < lines; i++ {
		start := i * 32
		end := start + 32
		if end > len(qr) {
			end = len(qr)
		}
		fmt.Printf("║  %s ║\n", string(qr[start:end]))
	}
}
