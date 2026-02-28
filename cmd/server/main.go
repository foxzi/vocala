package main

import (
	"html/template"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"time"

	"github.com/kidandcat/voicechat/internal/auth"
	"github.com/kidandcat/voicechat/internal/channel"
	"github.com/kidandcat/voicechat/internal/database"
	"github.com/kidandcat/voicechat/internal/signaling"
)

var templates *template.Template

func main() {
	database.Init("voicechat.db")

	templates = template.Must(template.ParseGlob(filepath.Join("web", "templates", "*.html")))

	mux := http.NewServeMux()

	// Static files
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))

	// Auth routes
	mux.HandleFunc("/login", handleLogin)
	mux.HandleFunc("/register", handleRegister)
	mux.HandleFunc("/logout", handleLogout)

	// App routes (auth required)
	mux.HandleFunc("/", requireAuth(handleApp))
	mux.HandleFunc("/channels", requireAuth(handleChannels))
	mux.HandleFunc("/channels/delete", requireAuth(handleDeleteChannel))

	// WebSocket
	mux.HandleFunc("/ws", signaling.HandleWebSocket)

	addr := ":8090"
	log.Printf("VoiceChat server starting on http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := auth.UserFromRequest(r)
		if user == nil {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
		r.Header.Set("X-User-ID", strconv.FormatInt(user.ID, 10))
		r.Header.Set("X-Username", user.Username)
		next(w, r)
	}
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if auth.UserFromRequest(r) != nil {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		templates.ExecuteTemplate(w, "login.html", nil)
		return
	}

	username := r.FormValue("username")
	password := r.FormValue("password")

	user, err := auth.Login(username, password)
	if err != nil {
		templates.ExecuteTemplate(w, "login.html", map[string]string{"Error": "Invalid username or password"})
		return
	}

	token, err := auth.CreateSession(user.ID)
	if err != nil {
		templates.ExecuteTemplate(w, "login.html", map[string]string{"Error": "Something went wrong"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400 * 30,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		if auth.UserFromRequest(r) != nil {
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		templates.ExecuteTemplate(w, "register.html", nil)
		return
	}

	username := r.FormValue("username")
	password := r.FormValue("password")

	if len(username) < 2 || len(password) < 4 {
		templates.ExecuteTemplate(w, "register.html", map[string]string{"Error": "Username must be at least 2 characters, password at least 4"})
		return
	}

	user, err := auth.Register(username, password)
	if err != nil {
		templates.ExecuteTemplate(w, "register.html", map[string]string{"Error": "Username already taken"})
		return
	}

	token, err := auth.CreateSession(user.ID)
	if err != nil {
		templates.ExecuteTemplate(w, "register.html", map[string]string{"Error": "Something went wrong"})
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400 * 30,
	})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie("session"); err == nil {
		auth.DeleteSession(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func handleApp(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	user := auth.UserFromRequest(r)
	channels, _ := channel.List()

	data := map[string]any{
		"User":     user,
		"Channels": channels,
	}
	templates.ExecuteTemplate(w, "app.html", data)
}

func handleChannels(w http.ResponseWriter, r *http.Request) {
	user := auth.UserFromRequest(r)

	if r.Method == http.MethodPost {
		name := r.FormValue("name")
		if name != "" {
			channel.Create(name, user.ID)
		}
	}

	channels, _ := channel.List()
	data := map[string]any{
		"User":     user,
		"Channels": channels,
	}

	// Return just the channel list partial for HTMX
	templates.ExecuteTemplate(w, "channel-list", data)
}

func handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	idStr := r.FormValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	channel.Delete(id)

	user := auth.UserFromRequest(r)
	channels, _ := channel.List()
	data := map[string]any{
		"User":     user,
		"Channels": channels,
	}
	templates.ExecuteTemplate(w, "channel-list", data)
}
