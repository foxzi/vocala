package channel

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/foxzi/vocala/internal/database"
)

var validChannelName = regexp.MustCompile(`^[a-zA-Z0-9_\-. ]{1,50}$`)

type Channel struct {
	ID          int64
	Name        string
	CreatedBy   int64
	IsPrivate   bool
	IsEphemeral bool
	IsDM        bool
	DMUserA     int64
	DMUserB     int64
}

type DMSummary struct {
	ChannelID    int64  `json:"channel_id"`
	OtherUserID  int64  `json:"other_user_id"`
	OtherName    string `json:"other_name"`
	LastMessage  string `json:"last_message"`
	LastTime     int64  `json:"last_time"`
	LastHuddleAt int64  `json:"last_huddle_at"`
	UnreadCount  int    `json:"unread_count"`
}

type ConnectedUser struct {
	ID       int64
	Username string
	Muted    bool
	Speaking bool
}

// In-memory state for who's in which channel
var (
	mu            sync.RWMutex
	channelUsers  = make(map[int64]map[int64]*ConnectedUser) // channelID -> userID -> user
	userToChannel = make(map[int64]int64)                    // userID -> channelID
)

func ValidateName(name string) error {
	if !validChannelName.MatchString(name) {
		return errors.New("channel name must be 1-50 chars: letters, digits, _ - . or spaces")
	}
	return nil
}

func Create(name string, createdBy int64, isPrivate bool) (*Channel, error) {
	if err := ValidateName(name); err != nil {
		return nil, err
	}
	res, err := database.DB.Exec(
		"INSERT INTO channels (name, created_by, is_private) VALUES (?, ?, ?)",
		name, createdBy, isPrivate,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	ch := &Channel{ID: id, Name: name, CreatedBy: createdBy, IsPrivate: isPrivate}

	// Creator is automatically a member of private channels
	if isPrivate {
		AddMember(id, createdBy)
	}

	return ch, nil
}

func List() ([]Channel, error) {
	rows, err := database.DB.Query("SELECT id, name, created_by, is_private, is_ephemeral FROM channels WHERE is_dm = 0 ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.CreatedBy, &ch.IsPrivate, &ch.IsEphemeral); err != nil {
			return nil, err
		}
		channels = append(channels, ch)
	}
	return channels, nil
}

// ListForUser returns channels visible to the given user.
// Public channels are always included; private channels only if the user
// is the creator, a member, or an admin.
func ListForUser(userID int64, isAdmin bool) ([]Channel, error) {
	query := "SELECT id, name, created_by, is_private, is_ephemeral FROM channels WHERE is_dm = 0 AND is_ephemeral = 0 ORDER BY name"
	args := []any{}
	if !isAdmin {
		query = `SELECT id, name, created_by, is_private, is_ephemeral FROM channels
		         WHERE is_dm = 0 AND is_ephemeral = 0 AND (
		            is_private = 0
		            OR created_by = ?
		            OR id IN (SELECT channel_id FROM channel_members WHERE user_id = ?)
		         )
		         ORDER BY name`
		args = []any{userID, userID}
	}

	rows, err := database.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.CreatedBy, &ch.IsPrivate, &ch.IsEphemeral); err != nil {
			return nil, err
		}
		channels = append(channels, ch)
	}
	return channels, nil
}

func GetByID(id int64) (*Channel, error) {
	var ch Channel
	err := database.DB.QueryRow(
		`SELECT id, name, created_by, is_private, is_ephemeral, is_dm, dm_user_a, dm_user_b
		 FROM channels WHERE id = ?`, id,
	).Scan(&ch.ID, &ch.Name, &ch.CreatedBy, &ch.IsPrivate, &ch.IsEphemeral, &ch.IsDM, &ch.DMUserA, &ch.DMUserB)
	if err != nil {
		return nil, err
	}
	return &ch, nil
}

func Delete(id int64) error {
	_, err := database.DB.Exec("DELETE FROM channels WHERE id = ?", id)
	return err
}

// CreateEphemeral creates a private, ephemeral (auto-cleanup) channel.
// Used by Quick rooms and Huddles. Returns the new channel and a slug-name.
func CreateEphemeral(prefix string, createdBy int64, extraMember int64) (*Channel, error) {
	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return nil, err
	}
	name := fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(suffix))
	for {
		var existing int
		_ = database.DB.QueryRow("SELECT 1 FROM channels WHERE name = ?", name).Scan(&existing)
		if existing == 0 {
			break
		}
		_, _ = rand.Read(suffix)
		name = fmt.Sprintf("%s-%s", prefix, hex.EncodeToString(suffix))
	}
	res, err := database.DB.Exec(
		"INSERT INTO channels (name, created_by, is_private, is_ephemeral) VALUES (?, ?, 1, 1)",
		name, createdBy,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	ch := &Channel{ID: id, Name: name, CreatedBy: createdBy, IsPrivate: true, IsEphemeral: true}
	AddMember(id, createdBy)
	if extraMember > 0 && extraMember != createdBy {
		AddMember(id, extraMember)
	}
	return ch, nil
}

// MarkEphemeralEmptyState updates the empty-since timestamp on ephemeral
// channels: sets it to now when no users remain, clears it when someone joins.
func MarkEphemeralEmptyState(channelID int64) {
	users := GetUsers(channelID)
	var ts int64
	if len(users) == 0 {
		ts = time.Now().Unix()
	}
	database.DB.Exec(
		"UPDATE channels SET ephemeral_empty_since = ? WHERE id = ? AND is_ephemeral = 1",
		ts, channelID,
	)
}

// CleanupEphemeralOlderThan removes ephemeral channels that have been empty
// for at least the given duration. Returns the number of channels deleted.
func CleanupEphemeralOlderThan(emptyFor time.Duration) (int, error) {
	cutoff := time.Now().Unix() - int64(emptyFor.Seconds())
	rows, err := database.DB.Query(
		"SELECT id FROM channels WHERE is_ephemeral = 1 AND ephemeral_empty_since > 0 AND ephemeral_empty_since < ?",
		cutoff,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		database.DB.Exec("DELETE FROM channels WHERE id = ?", id)
	}
	return len(ids), nil
}

func dmPairKey(a, b int64) (int64, int64) {
	if a < b {
		return a, b
	}
	return b, a
}

// OpenDM returns the channel id for a private 1-to-1 DM between two users,
// creating it on the fly if it doesn't exist yet.
func OpenDM(userA, userB int64) (*Channel, error) {
	if userA == userB || userA == 0 || userB == 0 {
		return nil, errors.New("invalid DM pair")
	}
	lo, hi := dmPairKey(userA, userB)
	var ch Channel
	row := database.DB.QueryRow(
		`SELECT id, name, created_by, is_private, is_ephemeral, is_dm, dm_user_a, dm_user_b
		 FROM channels WHERE is_dm = 1 AND dm_user_a = ? AND dm_user_b = ?`,
		lo, hi,
	)
	if err := row.Scan(&ch.ID, &ch.Name, &ch.CreatedBy, &ch.IsPrivate, &ch.IsEphemeral, &ch.IsDM, &ch.DMUserA, &ch.DMUserB); err == nil {
		return &ch, nil
	}
	name := fmt.Sprintf("dm-%d-%d", lo, hi)
	res, err := database.DB.Exec(
		`INSERT INTO channels (name, created_by, is_private, is_dm, dm_user_a, dm_user_b)
		 VALUES (?, ?, 1, 1, ?, ?)`,
		name, userA, lo, hi,
	)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()
	AddMember(id, lo)
	AddMember(id, hi)
	return &Channel{ID: id, Name: name, CreatedBy: userA, IsPrivate: true, IsDM: true, DMUserA: lo, DMUserB: hi}, nil
}

// ListGroupsForUser returns ephemeral group channels (created by
// "Add people to a huddle") where the user is a member.
func ListGroupsForUser(userID int64) ([]Channel, error) {
	rows, err := database.DB.Query(
		`SELECT c.id, c.name, c.created_by, c.is_private, c.is_ephemeral, c.is_dm, c.dm_user_a, c.dm_user_b
		 FROM channels c
		 WHERE c.is_dm = 0 AND c.is_ephemeral = 1 AND c.name LIKE 'Group-%'
		   AND (c.created_by = ? OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id = ?))
		 ORDER BY c.id DESC`,
		userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Channel
	for rows.Next() {
		var ch Channel
		if err := rows.Scan(&ch.ID, &ch.Name, &ch.CreatedBy, &ch.IsPrivate, &ch.IsEphemeral, &ch.IsDM, &ch.DMUserA, &ch.DMUserB); err != nil {
			continue
		}
		out = append(out, ch)
	}
	return out, nil
}

// ListDMsForUser returns a summary list of the user's DM channels,
// ordered by most recent activity first.
func ListDMsForUser(userID int64) ([]DMSummary, error) {
	rows, err := database.DB.Query(
		`SELECT c.id, c.dm_user_a, c.dm_user_b, c.last_huddle_at,
		        u.username,
		        IFNULL((
		            SELECT text FROM chat_messages
		            WHERE channel_id = c.id
		            ORDER BY created_at DESC, id DESC LIMIT 1
		        ), '') AS last_text,
		        IFNULL((
		            SELECT created_at FROM chat_messages
		            WHERE channel_id = c.id
		            ORDER BY created_at DESC, id DESC LIMIT 1
		        ), 0) AS last_ts,
		        IFNULL((
		            SELECT COUNT(*) FROM chat_messages m
		            WHERE m.channel_id = c.id
		              AND m.user_id != ?
		              AND m.kind = ''
		              AND m.created_at > IFNULL((
		                  SELECT last_read_at FROM channel_last_read
		                  WHERE user_id = ? AND channel_id = c.id
		              ), 0)
		        ), 0) AS unread
		 FROM channels c
		 JOIN users u ON u.id = CASE WHEN c.dm_user_a = ? THEN c.dm_user_b ELSE c.dm_user_a END
		 WHERE c.is_dm = 1 AND (c.dm_user_a = ? OR c.dm_user_b = ?)
		 ORDER BY MAX(last_ts, c.last_huddle_at) DESC, c.id DESC`,
		userID, userID, userID, userID, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DMSummary
	for rows.Next() {
		var s DMSummary
		var ua, ub int64
		if err := rows.Scan(&s.ChannelID, &ua, &ub, &s.LastHuddleAt, &s.OtherName, &s.LastMessage, &s.LastTime, &s.UnreadCount); err != nil {
			continue
		}
		if ua == userID {
			s.OtherUserID = ub
		} else {
			s.OtherUserID = ua
		}
		out = append(out, s)
	}
	return out, nil
}

// PurgeStaleDMMembers removes any rows from channel_members for DM channels
// where the user is neither dm_user_a nor dm_user_b. Older code paths could
// add extra members to a DM via "Add people"; this resets the invariant so
// CanJoin works correctly.
func PurgeStaleDMMembers() error {
	_, err := database.DB.Exec(
		`DELETE FROM channel_members
		 WHERE channel_id IN (SELECT id FROM channels WHERE is_dm = 1)
		   AND user_id NOT IN (
		       SELECT dm_user_a FROM channels WHERE id = channel_members.channel_id
		       UNION
		       SELECT dm_user_b FROM channels WHERE id = channel_members.channel_id
		   )`,
	)
	return err
}

// MarkChannelRead records that the user has read messages up to now in the
// given channel. Used to compute unread counts.
func MarkChannelRead(userID, channelID int64) {
	if userID == 0 || channelID == 0 {
		return
	}
	now := time.Now().Unix()
	database.DB.Exec(
		`INSERT INTO channel_last_read (user_id, channel_id, last_read_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = ?`,
		userID, channelID, now, now,
	)
}

// UpdateDMHuddleTime records the time of the most recent huddle inside the
// DM between two users. Called by the huddle handler so the DM list can
// surface "had a huddle 5m ago".
func UpdateDMHuddleTime(userA, userB int64, ts int64) {
	lo, hi := dmPairKey(userA, userB)
	database.DB.Exec(
		`UPDATE channels SET last_huddle_at = ? WHERE is_dm = 1 AND dm_user_a = ? AND dm_user_b = ?`,
		ts, lo, hi,
	)
}

// SetPrivacy toggles a channel's is_private flag. When making a channel
// private, the creator is automatically added as a member so they retain
// access. When making it public, the membership table is left intact —
// existing memberships become inert until the channel is private again.
func SetPrivacy(channelID int64, isPrivate bool) error {
	ch, err := GetByID(channelID)
	if err != nil {
		return err
	}
	if ch.IsPrivate == isPrivate {
		return nil
	}
	if _, err := database.DB.Exec("UPDATE channels SET is_private = ? WHERE id = ?", isPrivate, channelID); err != nil {
		return err
	}
	if isPrivate {
		AddMember(channelID, ch.CreatedBy)
	}
	return nil
}

func Join(channelID int64, userID int64, username string) {
	var prev int64
	mu.Lock()
	// Leave current channel first
	if oldCh, ok := userToChannel[userID]; ok {
		if users, exists := channelUsers[oldCh]; exists {
			delete(users, userID)
		}
		prev = oldCh
	}

	if channelUsers[channelID] == nil {
		channelUsers[channelID] = make(map[int64]*ConnectedUser)
	}
	channelUsers[channelID][userID] = &ConnectedUser{
		ID:       userID,
		Username: username,
	}
	userToChannel[userID] = channelID
	mu.Unlock()

	if prev != 0 && prev != channelID {
		MarkEphemeralEmptyState(prev)
	}
	MarkEphemeralEmptyState(channelID)
}

func Leave(userID int64) int64 {
	mu.Lock()
	chID, ok := userToChannel[userID]
	if !ok {
		mu.Unlock()
		return 0
	}

	if users, exists := channelUsers[chID]; exists {
		delete(users, userID)
	}
	delete(userToChannel, userID)
	mu.Unlock()

	MarkEphemeralEmptyState(chID)
	return chID
}

func GetUsers(channelID int64) []*ConnectedUser {
	mu.RLock()
	defer mu.RUnlock()

	users := channelUsers[channelID]
	result := make([]*ConnectedUser, 0, len(users))
	for _, u := range users {
		result = append(result, u)
	}
	return result
}

func GetUserChannel(userID int64) int64 {
	mu.RLock()
	defer mu.RUnlock()
	return userToChannel[userID]
}

func SetMuted(userID int64, muted bool) {
	mu.Lock()
	defer mu.Unlock()

	chID, ok := userToChannel[userID]
	if !ok {
		return
	}
	if u, exists := channelUsers[chID][userID]; exists {
		u.Muted = muted
	}
}

func SetSpeaking(userID int64, speaking bool) {
	mu.Lock()
	defer mu.Unlock()

	chID, ok := userToChannel[userID]
	if !ok {
		return
	}
	if u, exists := channelUsers[chID][userID]; exists {
		u.Speaking = speaking
	}
}

func GetAllChannelStates() map[int64][]*ConnectedUser {
	mu.RLock()
	defer mu.RUnlock()

	result := make(map[int64][]*ConnectedUser)
	for chID, users := range channelUsers {
		list := make([]*ConnectedUser, 0, len(users))
		for _, u := range users {
			list = append(list, u)
		}
		result[chID] = list
	}
	return result
}

// --- Private channel membership ---

func AddMember(channelID, userID int64) error {
	_, err := database.DB.Exec(
		"INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?, ?)",
		channelID, userID,
	)
	return err
}

func RemoveMember(channelID, userID int64) error {
	_, err := database.DB.Exec(
		"DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?",
		channelID, userID,
	)
	return err
}

func IsMember(channelID, userID int64) bool {
	var count int
	database.DB.QueryRow(
		"SELECT COUNT(*) FROM channel_members WHERE channel_id = ? AND user_id = ?",
		channelID, userID,
	).Scan(&count)
	return count > 0
}

func GetMembers(channelID int64) ([]int64, error) {
	rows, err := database.DB.Query(
		"SELECT user_id FROM channel_members WHERE channel_id = ?", channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			continue
		}
		members = append(members, id)
	}
	return members, nil
}

type Member struct {
	UserID   int64
	Username string
}

func GetMembersWithNames(channelID int64) ([]Member, error) {
	rows, err := database.DB.Query(
		`SELECT cm.user_id, u.username FROM channel_members cm
		 JOIN users u ON u.id = cm.user_id
		 WHERE cm.channel_id = ? ORDER BY u.username`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []Member
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Username); err != nil {
			continue
		}
		members = append(members, m)
	}
	return members, nil
}

// CanJoin checks if a user has access to join a channel.
// Public channels: anyone can join.
// Private channels: members, creator, or admins.
func CanJoin(channelID, userID int64, isAdmin bool) bool {
	ch, err := GetByID(channelID)
	if err != nil {
		return false
	}
	if ch.IsDM {
		return ch.DMUserA == userID || ch.DMUserB == userID
	}
	if !ch.IsPrivate {
		return true
	}
	if ch.CreatedBy == userID || isAdmin {
		return true
	}
	return IsMember(channelID, userID)
}

// CanManage checks if a user can manage members of a private channel.
func CanManage(channelID, userID int64, isAdmin bool) bool {
	ch, err := GetByID(channelID)
	if err != nil {
		return false
	}
	if isAdmin {
		return true
	}
	return ch.CreatedBy == userID
}

// --- Invite links ---

func generateToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// CreateInvite generates a 7-day invite link token for a private channel.
func CreateInvite(channelID, createdBy int64) (string, error) {
	token := generateToken()
	now := time.Now().Unix()
	expires := time.Now().Add(7 * 24 * time.Hour).Unix()
	_, err := database.DB.Exec(
		`INSERT INTO channel_invites (token, channel_id, created_by, created_at, expires_at, max_uses, uses)
		 VALUES (?, ?, ?, ?, ?, 0, 0)`,
		token, channelID, createdBy, now, expires,
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// AcceptInvite validates and uses an invite token, adding the user as a member.
func AcceptInvite(token string, userID int64) (int64, error) {
	var channelID int64
	var expiresAt int64
	var maxUses, uses int
	err := database.DB.QueryRow(
		`SELECT channel_id, expires_at, max_uses, uses FROM channel_invites WHERE token = ?`,
		token,
	).Scan(&channelID, &expiresAt, &maxUses, &uses)
	if err != nil {
		return 0, fmt.Errorf("invite not found")
	}
	if time.Now().Unix() > expiresAt {
		return 0, fmt.Errorf("invite expired")
	}
	if maxUses > 0 && uses >= maxUses {
		return 0, fmt.Errorf("invite max uses reached")
	}

	// Add as member
	if err := AddMember(channelID, userID); err != nil {
		return 0, err
	}

	// Increment uses
	database.DB.Exec(`UPDATE channel_invites SET uses = uses + 1 WHERE token = ?`, token)

	return channelID, nil
}

// GetInvites returns active invites for a channel.
func GetInvites(channelID int64) ([]map[string]any, error) {
	now := time.Now().Unix()
	rows, err := database.DB.Query(
		`SELECT token, created_at, expires_at, max_uses, uses FROM channel_invites
		 WHERE channel_id = ? AND expires_at > ? ORDER BY created_at DESC`,
		channelID, now,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var invites []map[string]any
	for rows.Next() {
		var token string
		var createdAt, expiresAt int64
		var maxUses, uses int
		if err := rows.Scan(&token, &createdAt, &expiresAt, &maxUses, &uses); err != nil {
			continue
		}
		invites = append(invites, map[string]any{
			"token":      token,
			"created_at": createdAt,
			"expires_at": expiresAt,
			"max_uses":   maxUses,
			"uses":       uses,
		})
	}
	return invites, nil
}

func DeleteInvite(token string) error {
	_, err := database.DB.Exec(`DELETE FROM channel_invites WHERE token = ?`, token)
	return err
}

// --- Guest invites ---

// CreateGuestInvite generates a temporary guest invite link for a channel.
func CreateGuestInvite(channelID, createdBy int64, hours int) (string, error) {
	token := generateToken()
	now := time.Now().Unix()
	expires := time.Now().Add(time.Duration(hours) * time.Hour).Unix()
	_, err := database.DB.Exec(
		`INSERT INTO guest_invites (token, channel_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		token, channelID, createdBy, now, expires,
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// ValidateGuestInvite checks if a guest invite is valid and returns channel ID and expiry.
func ValidateGuestInvite(token string) (int64, int64, error) {
	var channelID, expiresAt int64
	err := database.DB.QueryRow(
		`SELECT channel_id, expires_at FROM guest_invites WHERE token = ?`, token,
	).Scan(&channelID, &expiresAt)
	if err != nil {
		return 0, 0, fmt.Errorf("invite not found")
	}
	if time.Now().Unix() > expiresAt {
		return 0, 0, fmt.Errorf("invite expired")
	}
	return channelID, expiresAt, nil
}

// CreateGuestSession creates a temporary session for a guest user.
func CreateGuestSession(guestName string, channelID int64, inviteToken string, expiresAt int64) (string, error) {
	now := time.Now().Unix()
	if expiresAt <= now {
		return "", fmt.Errorf("invite expired")
	}

	sessionToken := generateToken()
	_, err := database.DB.Exec(
		`INSERT INTO guest_sessions (token, guest_name, channel_id, invite_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
		sessionToken, guestName, channelID, inviteToken, now, expiresAt,
	)
	if err != nil {
		return "", err
	}
	return sessionToken, nil
}

// GuestSession represents an active guest session.
type GuestSession struct {
	Token     string
	GuestName string
	ChannelID int64
	ExpiresAt int64
}

// ValidateGuestSession checks if a guest session is valid.
func ValidateGuestSession(token string) (*GuestSession, error) {
	var gs GuestSession
	err := database.DB.QueryRow(
		`SELECT token, guest_name, channel_id, expires_at FROM guest_sessions WHERE token = ?`, token,
	).Scan(&gs.Token, &gs.GuestName, &gs.ChannelID, &gs.ExpiresAt)
	if err != nil {
		return nil, fmt.Errorf("session not found")
	}
	if time.Now().Unix() > gs.ExpiresAt {
		database.DB.Exec(`DELETE FROM guest_sessions WHERE token = ?`, token)
		return nil, fmt.Errorf("session expired")
	}
	return &gs, nil
}
