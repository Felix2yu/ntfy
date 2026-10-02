package server

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"heckel.io/ntfy/v2/model"
)

func TestServer_Manager_Prune_Messages_Without_Attachments_DoesNotPanic(t *testing.T) {
	forEachBackend(t, func(t *testing.T, databaseURL string) {
		// Tests that the manager runs without attachment-cache-dir set, see #617
		c := newTestConfig(t, databaseURL)
		c.AttachmentCacheDir = ""
		// 必须给非零CacheDuration：pruneMessages 在 CacheDuration==0 时直接 return
		// （"Infinite retention, no messages to prune"），消息不会被删，
		// 本用例要断言的 "Actually deleted" 就不会成立。
		// 本仓库 DefaultCacheDuration 已改成 0（永不过期，见 563c9de2）。
		c.CacheDuration = 12 * time.Hour
		s := newTestServer(t, c)

		// Publish a message
		rr := request(t, s, "POST", "/mytopic", "hi", nil)
		require.Equal(t, 200, rr.Code)
		m := toMessage(t, rr.Body.String())

		// Expire message
		require.Nil(t, s.messageCache.ExpireMessages("mytopic"))

		// Does not panic
		s.pruneMessages()

		// Actually deleted
		_, err := s.messageCache.Message(m.ID)
		require.Equal(t, model.ErrMessageNotFound, err)
	})
}
