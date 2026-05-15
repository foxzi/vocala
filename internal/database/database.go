package database

import (
	"database/sql"
	"log"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// ChatMessage represents a stored chat message.
type ChatMessage struct {
	ID        string `json:"id"`
	ChannelID int64  `json:"channel_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	Text      string `json:"text"`
	CreatedAt int64  `json:"timestamp"`
	Kind      string `json:"kind,omitempty"`
}

var DB *sql.DB

func Init(dbPath string) {
	var err error
	DB, err = sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_foreign_keys=on")
	if err != nil {
		log.Fatal("failed to open database:", err)
	}

	if err = DB.Ping(); err != nil {
		log.Fatal("failed to ping database:", err)
	}

	migrate()
}

func migrate() {
	queries := []string{
		`CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			is_admin INTEGER NOT NULL DEFAULT 0,
			is_active INTEGER NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS channels (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT UNIQUE NOT NULL,
			created_by INTEGER REFERENCES users(id),
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			expires_at DATETIME NOT NULL DEFAULT (datetime('now', '+30 days'))
		)`,
		`CREATE TABLE IF NOT EXISTS chat_messages (
			id TEXT PRIMARY KEY,
			channel_id INTEGER NOT NULL,
			user_id INTEGER NOT NULL,
			username TEXT NOT NULL,
			text TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON chat_messages(channel_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS chat_reactions (
			message_id TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			username TEXT NOT NULL,
			emoji TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (message_id, user_id, emoji)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_reactions_message ON chat_reactions(message_id)`,
		`CREATE TABLE IF NOT EXISTS channel_members (
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			PRIMARY KEY (channel_id, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS channel_invites (
			token TEXT PRIMARY KEY,
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			created_by INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			max_uses INTEGER NOT NULL DEFAULT 0,
			uses INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS guest_invites (
			token TEXT PRIMARY KEY,
			channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
			created_by INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS guest_sessions (
			token TEXT PRIMARY KEY,
			guest_name TEXT NOT NULL,
			channel_id INTEGER NOT NULL,
			invite_token TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL
		)`,
	}

	for _, q := range queries {
		if _, err := DB.Exec(q); err != nil {
			log.Fatal("migration failed:", err)
		}
	}

	// Migrations for existing databases
	migrations := []string{
		`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE channels ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN oauth_provider TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN oauth_id TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE channels ADD COLUMN is_ephemeral INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE channels ADD COLUMN ephemeral_empty_since INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE channels ADD COLUMN is_dm INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE channels ADD COLUMN dm_user_a INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE channels ADD COLUMN dm_user_b INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE channels ADD COLUMN last_huddle_at INTEGER NOT NULL DEFAULT 0`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm_pair ON channels(dm_user_a, dm_user_b) WHERE is_dm = 1`,
		`ALTER TABLE chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT ''`,
		`CREATE TABLE IF NOT EXISTS channel_last_read (
			user_id INTEGER NOT NULL,
			channel_id INTEGER NOT NULL,
			last_read_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (user_id, channel_id)
		)`,
	}
	for _, q := range migrations {
		DB.Exec(q) // ignore errors if columns already exist
	}
}

// SaveChatMessage stores a chat message in the database.
func SaveChatMessage(msg ChatMessage) error {
	_, err := DB.Exec(
		`INSERT INTO chat_messages (id, channel_id, user_id, username, text, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		msg.ID, msg.ChannelID, msg.UserID, msg.Username, msg.Text, msg.CreatedAt, msg.Kind,
	)
	return err
}

// GetChatHistory returns the last N messages for a channel, oldest first.
func GetChatHistory(channelID int64, limit int) ([]ChatMessage, error) {
	rows, err := DB.Query(
		`SELECT id, channel_id, user_id, username, text, created_at, IFNULL(kind,'') FROM chat_messages
		 WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
		channelID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var msgs []ChatMessage
	for rows.Next() {
		var m ChatMessage
		if err := rows.Scan(&m.ID, &m.ChannelID, &m.UserID, &m.Username, &m.Text, &m.CreatedAt, &m.Kind); err != nil {
			continue
		}
		msgs = append(msgs, m)
	}
	// Reverse to get oldest first
	for i, j := 0, len(msgs)-1; i < j; i, j = i+1, j-1 {
		msgs[i], msgs[j] = msgs[j], msgs[i]
	}
	return msgs, nil
}

// ClearChannelMessages deletes all messages in a channel.
func ClearChannelMessages(channelID int64) {
	DB.Exec(`DELETE FROM chat_reactions WHERE message_id IN (SELECT id FROM chat_messages WHERE channel_id = ?)`, channelID)
	DB.Exec(`DELETE FROM chat_messages WHERE channel_id = ?`, channelID)
}

// GetMessageChannel returns the channel ID a message belongs to (or 0).
func GetMessageChannel(messageID string) (int64, error) {
	var chID int64
	err := DB.QueryRow(`SELECT channel_id FROM chat_messages WHERE id = ?`, messageID).Scan(&chID)
	if err != nil {
		return 0, err
	}
	return chID, nil
}

// ChatReaction represents a stored reaction.
type ChatReaction struct {
	MessageID string `json:"message_id"`
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	Emoji     string `json:"emoji"`
}

// AddChatReaction inserts a reaction. Returns true if newly inserted, false if it already existed.
func AddChatReaction(r ChatReaction, createdAt int64) (bool, error) {
	res, err := DB.Exec(
		`INSERT OR IGNORE INTO chat_reactions (message_id, user_id, username, emoji, created_at) VALUES (?, ?, ?, ?, ?)`,
		r.MessageID, r.UserID, r.Username, r.Emoji, createdAt,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// RemoveChatReaction removes a single user's reaction.
func RemoveChatReaction(messageID string, userID int64, emoji string) error {
	_, err := DB.Exec(
		`DELETE FROM chat_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
		messageID, userID, emoji,
	)
	return err
}

// GetReactionsForMessages returns all reactions for the given message IDs.
func GetReactionsForMessages(messageIDs []string) ([]ChatReaction, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}
	placeholders := ""
	args := make([]any, 0, len(messageIDs))
	for i, id := range messageIDs {
		if i > 0 {
			placeholders += ","
		}
		placeholders += "?"
		args = append(args, id)
	}
	rows, err := DB.Query(
		`SELECT message_id, user_id, username, emoji FROM chat_reactions WHERE message_id IN (`+placeholders+`) ORDER BY created_at ASC`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChatReaction
	for rows.Next() {
		var r ChatReaction
		if err := rows.Scan(&r.MessageID, &r.UserID, &r.Username, &r.Emoji); err != nil {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

// CleanupOldMessages removes messages older than the given retention period.
func CleanupOldMessages(retentionDays int) (int64, error) {
	cutoff := time.Now().AddDate(0, 0, -retentionDays).Unix()
	result, err := DB.Exec(`DELETE FROM chat_messages WHERE created_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
