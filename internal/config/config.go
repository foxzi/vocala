package config

import (
	"log"
	"os"
	"strconv"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server        ServerConfig        `yaml:"server"`
	Database      DatabaseConfig      `yaml:"database"`
	WebRTC        WebRTCConfig        `yaml:"webrtc"`
	TURN          TURNConfig          `yaml:"turn"`
	Auth          AuthConfig          `yaml:"auth"`
	OAuth         OAuthConfig         `yaml:"oauth"`
	Security      SecurityConfig      `yaml:"security"`
	Storage       StorageConfig       `yaml:"storage"`
	Recording     RecordingConfig     `yaml:"recording"`
	Transcription TranscriptionConfig `yaml:"transcription"`
}

// TranscriptionConfig points to a self-hosted, OpenAI-compatible speech
// service (speaches). An empty URL turns transcription off.
type TranscriptionConfig struct {
	URL      string `yaml:"url"`      // e.g. http://whisper:8000
	Model    string `yaml:"model"`    // Hugging Face model id
	Language string `yaml:"language"` // ISO 639-1; empty = autodetect
}

// StorageConfig selects where finished files (recordings) are kept.
type StorageConfig struct {
	Backend string             `yaml:"backend"` // "local" or "s3"
	Local   LocalStorageConfig `yaml:"local"`
	S3      S3StorageConfig    `yaml:"s3"`
}

// S3StorageConfig points to a bucket in any S3-compatible storage. Keys are
// better passed as VOCALA_S3_ACCESS_KEY / VOCALA_S3_SECRET_KEY than kept in
// the file.
type S3StorageConfig struct {
	Endpoint  string `yaml:"endpoint"` // host[:port], no scheme
	Region    string `yaml:"region"`
	Bucket    string `yaml:"bucket"`
	Prefix    string `yaml:"prefix"`
	AccessKey string `yaml:"access_key"`
	SecretKey string `yaml:"secret_key"`
	Insecure  bool   `yaml:"insecure"` // plain HTTP
}

type LocalStorageConfig struct {
	Dir string `yaml:"dir"` // empty = <directory of database.path>/storage
}

// RecordingConfig controls server-side call recording.
type RecordingConfig struct {
	Enabled       bool   `yaml:"enabled"`
	TmpDir        string `yaml:"tmp_dir"`        // files being written; default <storage.local.dir>/tmp
	MaxHours      int    `yaml:"max_hours"`      // stop a forgotten recording; 0 = no limit
	RetentionDays int    `yaml:"retention_days"` // 0 = keep forever
}

type ServerConfig struct {
	Addr         string `yaml:"addr"`
	ReadTimeout  int    `yaml:"read_timeout"`  // seconds
	WriteTimeout int    `yaml:"write_timeout"` // seconds
	IdleTimeout  int    `yaml:"idle_timeout"`  // seconds
	LogLevel     string `yaml:"log_level"`     // debug, info, warn, error
}

type DatabaseConfig struct {
	Path              string `yaml:"path"`
	ChatRetentionDays int    `yaml:"chat_retention_days"` // 0 = keep forever
}

type WebRTCConfig struct {
	NATIP        string `yaml:"nat_ip"`
	UDPPortMin   uint16 `yaml:"udp_port_min"`
	UDPPortMax   uint16 `yaml:"udp_port_max"`
	ICETCPPort   uint16 `yaml:"ice_tcp_port"`   // TCP mux port for ICE TCP candidates; 0 disables
	MaxMessageKB int    `yaml:"max_message_kb"` // WebSocket message size limit
}

type TURNConfig struct {
	Enabled  bool   `yaml:"enabled"`
	IP       string `yaml:"ip"`
	Port     int    `yaml:"port"`      // UDP TURN port (default 3478)
	TLSPort  int    `yaml:"tls_port"`  // TLS TURNS port (default 5349, 0 = disabled)
	TLSHost  string `yaml:"tls_host"`  // Domain name for TURNS URI (must match TLS cert)
	CertFile string `yaml:"cert_file"` // TLS certificate file for TURNS
	KeyFile  string `yaml:"key_file"`  // TLS private key file for TURNS
}

type AuthConfig struct {
	SessionDays         int  `yaml:"session_days"`
	MinPassword         int  `yaml:"min_password"`
	CookieSecure        bool `yaml:"cookie_secure"`
	RegistrationEnabled bool `yaml:"registration_enabled"`
	RateLimitRPS        int  `yaml:"rate_limit_rps"`
	RateLimitBurst      int  `yaml:"rate_limit_burst"`
}

type SecurityConfig struct {
	AllowedOrigins []string `yaml:"allowed_origins"` // empty = same-origin only
}

type OAuthProvider struct {
	Name         string   `yaml:"name"` // display name ("Google", "GitHub", etc.)
	ClientID     string   `yaml:"client_id"`
	ClientSecret string   `yaml:"client_secret"`
	AuthURL      string   `yaml:"auth_url"`     // authorization endpoint
	TokenURL     string   `yaml:"token_url"`    // token endpoint
	UserInfoURL  string   `yaml:"userinfo_url"` // userinfo endpoint (for getting email/name)
	Scopes       []string `yaml:"scopes"`
	AutoActivate bool     `yaml:"auto_activate"` // auto-activate OAuth users (default: true)
}

type OAuthConfig struct {
	Enabled   bool            `yaml:"enabled"`
	Providers []OAuthProvider `yaml:"providers"`
}

// Default returns config with sensible defaults.
func Default() *Config {
	return &Config{
		Server: ServerConfig{
			Addr:         ":8090",
			ReadTimeout:  15,
			WriteTimeout: 30,
			IdleTimeout:  120,
			LogLevel:     "info",
		},
		Database: DatabaseConfig{
			Path:              "vocala.db",
			ChatRetentionDays: 30,
		},
		WebRTC: WebRTCConfig{
			UDPPortMin:   40000,
			UDPPortMax:   40200,
			ICETCPPort:   40201,
			MaxMessageKB: 512,
		},
		TURN: TURNConfig{
			Port:    3478,
			TLSPort: 5349,
		},
		Storage: StorageConfig{
			Backend: "local",
			S3:      S3StorageConfig{Prefix: "vocala/"},
		},
		Recording: RecordingConfig{
			Enabled:       true,
			MaxHours:      4,
			RetentionDays: 30,
		},
		Transcription: TranscriptionConfig{
			Model:    "Systran/faster-whisper-medium",
			Language: "ru",
		},
		Auth: AuthConfig{
			SessionDays:         30,
			MinPassword:         8,
			CookieSecure:        false,
			RegistrationEnabled: true,
			RateLimitRPS:        10,
			RateLimitBurst:      20,
		},
	}
}

// Load reads config from a YAML file, then applies env var overrides.
func Load(path string) *Config {
	cfg := Default()

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				log.Fatalf("config: failed to read %s: %v", path, err)
			}
			log.Printf("config: %s not found, using defaults", path)
		} else {
			if err := yaml.Unmarshal(data, cfg); err != nil {
				log.Fatalf("config: failed to parse %s: %v", path, err)
			}
			log.Printf("config: loaded from %s", path)
		}
	}

	// Env vars override YAML values
	envOverrides(cfg)

	return cfg
}

func envOverrides(cfg *Config) {
	if v := os.Getenv("VOCALA_ADDR"); v != "" {
		cfg.Server.Addr = v
	}
	if v := os.Getenv("VOCALA_DB_PATH"); v != "" {
		cfg.Database.Path = v
	}
	if v := os.Getenv("VOCALA_NAT_IP"); v != "" {
		cfg.WebRTC.NATIP = v
	}
	if v := os.Getenv("VOCALA_TURN_IP"); v != "" {
		cfg.TURN.Enabled = true
		cfg.TURN.IP = v
	}
	if v := os.Getenv("VOCALA_TURN_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil {
			cfg.TURN.Port = p
		}
	}
	if v := os.Getenv("VOCALA_COOKIE_SECURE"); v == "true" || v == "1" {
		cfg.Auth.CookieSecure = true
	}
	if v := os.Getenv("VOCALA_STT_URL"); v != "" {
		cfg.Transcription.URL = v
	}
	if v := os.Getenv("VOCALA_STT_MODEL"); v != "" {
		cfg.Transcription.Model = v
	}
	if v, ok := os.LookupEnv("VOCALA_STT_LANGUAGE"); ok {
		cfg.Transcription.Language = v
	}
	if v := os.Getenv("VOCALA_STORAGE_BACKEND"); v != "" {
		cfg.Storage.Backend = v
	}
	for env, dst := range map[string]*string{
		"VOCALA_S3_ENDPOINT":   &cfg.Storage.S3.Endpoint,
		"VOCALA_S3_REGION":     &cfg.Storage.S3.Region,
		"VOCALA_S3_BUCKET":     &cfg.Storage.S3.Bucket,
		"VOCALA_S3_PREFIX":     &cfg.Storage.S3.Prefix,
		"VOCALA_S3_ACCESS_KEY": &cfg.Storage.S3.AccessKey,
		"VOCALA_S3_SECRET_KEY": &cfg.Storage.S3.SecretKey,
	} {
		if v := os.Getenv(env); v != "" {
			*dst = v
		}
	}
	if v := os.Getenv("VOCALA_S3_INSECURE"); v == "true" || v == "1" {
		cfg.Storage.S3.Insecure = true
	} else if v == "false" || v == "0" {
		cfg.Storage.S3.Insecure = false
	}
	if v := os.Getenv("VOCALA_STORAGE_DIR"); v != "" {
		cfg.Storage.Local.Dir = v
	}
	if v := os.Getenv("VOCALA_RECORDING"); v == "false" || v == "0" {
		cfg.Recording.Enabled = false
	} else if v == "true" || v == "1" {
		cfg.Recording.Enabled = true
	}
	if v := os.Getenv("VOCALA_REGISTRATION"); v == "false" || v == "0" {
		cfg.Auth.RegistrationEnabled = false
	} else if v == "true" || v == "1" {
		cfg.Auth.RegistrationEnabled = true
	}
}
