package web

import (
	"embed"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

//go:embed static
var staticFS embed.FS

// Config controls static file serving behavior.
type Config struct {
	EnableDiskFallback bool
}

// NewHandler returns an http.Handler that serves embedded static files.
func NewHandler() http.Handler {
	return newHandler(staticFS, Config{EnableDiskFallback: true})
}

func newHandler(fsEmbed embed.FS, config Config) http.Handler {
	subFS, _ := fs.Sub(fsEmbed, "static")
	return &embeddedHandler{subFS: subFS, config: config}
}

type embeddedHandler struct {
	subFS  fs.FS
	config Config
}

func (h *embeddedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	upath := r.URL.Path
	if upath == "" || upath[0] != '/' {
		upath = "/" + upath
	}

	// Strip leading slash for embed.FS
	filePath := strings.TrimPrefix(filepath.ToSlash(upath), "/")
	if filePath == "" {
		filePath = "index.html"
	}
	embedPath := filePath

	content, err := fs.ReadFile(h.subFS, embedPath)
	if err != nil {
		// Fallback to disk for development
		if h.config.EnableDiskFallback {
			diskPath := filepath.Join("web/static", filePath)
			content, err = os.ReadFile(diskPath)
			if err != nil {
				http.NotFound(w, r)
				return
			}
		} else {
			http.NotFound(w, r)
			return
		}
	}

	ext := filepath.Ext(filePath)
	if ct := contentType(ext); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Write(content)
}

func contentType(ext string) string {
	switch ext {
	case ".html": return "text/html; charset=utf-8"
	case ".js":   return "application/javascript"
	case ".css":  return "text/css"
	case ".png":  return "image/png"
	case ".jpg", ".jpeg": return "image/jpeg"
	case ".gif":  return "image/gif"
	case ".svg":  return "image/svg+xml"
	case ".ico":  return "image/x-icon"
	case ".woff", ".woff2": return "font/woff2"
	case ".ttf":  return "font/ttf"
	case ".eot":  return "application/vnd.ms-fontobject"
	case ".pdf":  return "application/pdf"
	case ".zip":  return "application/zip"
	case ".tar":  return "application/x-tar"
	case ".gz":   return "application/gzip"
	case ".json": return "application/json"
	case ".xml":  return "application/xml"
	case ".txt":  return "text/plain"
	case ".wasm": return "application/wasm"
	default:      return "application/octet-stream"
	}
}
