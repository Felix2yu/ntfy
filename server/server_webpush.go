//go:build !nowebpush

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"

	"github.com/SherClockHolmes/webpush-go"
	"heckel.io/ntfy/v2/log"
	"heckel.io/ntfy/v2/model"
	"heckel.io/ntfy/v2/user"
	wpush "heckel.io/ntfy/v2/webpush"
)

const (
	// WebPushAvailable is a constant used to indicate that WebPush support is available.
	// It can be disabled with the 'nowebpush' build tag.
	WebPushAvailable = true

	webPushTopicSubscribeLimit = 50

	// defaultWebPushTTLSeconds is the delivery time-to-live used when neither web-push-ttl nor
	// cache-duration are configured. A TTL of 0 means "deliver now or drop", which is fatal for
	// mobile devices that are offline (or have the PWA suspended, as iOS does) when the message
	// is published. 4 weeks is the maximum that WebKit/APNs will hold a message.
	defaultWebPushTTLSeconds = 28 * 24 * 60 * 60
)

// webPushPermanentFailureStatusCodes are the push service responses that prove a subscription is
// gone for good: 404/410 mean "unknown or expired subscription", 401/403 mean the VAPID identity
// no longer matches the endpoint. Everything else -- most notably 429 (rate limiting) and 5xx
// (push service outages) -- is transient, and must not remove the subscription: there is no way
// to rebuild it without the client re-opening the app, which is exactly the failure mode we are
// trying to fix for iOS PWAs.
var webPushPermanentFailureStatusCodes = map[int]bool{
	http.StatusUnauthorized: true, // 401
	http.StatusForbidden:    true, // 403
	http.StatusNotFound:     true, // 404
	http.StatusGone:         true, // 410
}

func webPushSubscriptionIsGone(statusCode int) bool {
	return webPushPermanentFailureStatusCodes[statusCode]
}

// webPushAllowedEndpointsRegexes is the host-level allow-list of web push services ntfy
// will deliver to. Each regex anchors the scheme and matches the stable service host,
// followed by the authority/path boundary "/". Instance-specific labels (e.g. the
// "wns2-<region>" prefix on Windows Notification Service hosts) are wildcarded with
// a single-label pattern ([^/]+) that cannot span into the path.
// See GHSA-w9hq-5jg7-q4j7 for why wildcarding the entire host is insufficient.
var webPushAllowedEndpointsRegexes = []*regexp.Regexp{
	regexp.MustCompile(`^https://fcm\.googleapis\.com/`),
	regexp.MustCompile(`^https://jmt17\.google\.com/`),
	regexp.MustCompile(`^https://updates\.push\.services\.mozilla\.com/`),
	regexp.MustCompile(`^https://[^/]+\.mozaws\.net/`),
	regexp.MustCompile(`^https://web\.push\.apple\.com/`),
	regexp.MustCompile(`^https://[^/]+\.notify\.windows\.com/`),
}

func webPushEndpointAllowed(endpoint string) bool {
	for _, re := range webPushAllowedEndpointsRegexes {
		if re.MatchString(endpoint) {
			return true
		}
	}
	return false
}

func (s *Server) handleWebPushUpdate(w http.ResponseWriter, r *http.Request, v *visitor) error {
	req, err := readJSONWithLimit[apiWebPushUpdateSubscriptionRequest](r.Body, jsonBodyBytesLimit, false)
	if err != nil || req.Endpoint == "" || req.P256dh == "" || req.Auth == "" {
		return errHTTPBadRequestWebPushSubscriptionInvalid
	} else if !webPushEndpointAllowed(req.Endpoint) {
		return errHTTPBadRequestWebPushEndpointUnknown
	} else if len(req.Topics) > webPushTopicSubscribeLimit {
		return errHTTPBadRequestWebPushTopicCountTooHigh
	}
	topics, err := s.topicsFromIDs(v, req.Topics...)
	if err != nil {
		return err
	}
	if s.userManager != nil {
		u := v.User()
		for _, t := range topics {
			if err := s.userManager.Authorize(u, t.ID, user.PermissionRead); err != nil {
				logvr(v, r).With(t).Err(err).Debug("Access to topic %s not authorized", t.ID)
				return errHTTPForbidden.With(t)
			}
		}
	}
	if err := s.webPush.UpsertSubscription(req.Endpoint, req.Auth, req.P256dh, v.MaybeUserID(), v.IP(), req.Topics); err != nil {
		return err
	}
	return s.writeJSON(w, newSuccessResponse())
}

func (s *Server) handleWebPushDelete(w http.ResponseWriter, r *http.Request, _ *visitor) error {
	req, err := readJSONWithLimit[apiWebPushUpdateSubscriptionRequest](r.Body, jsonBodyBytesLimit, false)
	if err != nil || req.Endpoint == "" {
		return errHTTPBadRequestWebPushSubscriptionInvalid
	}
	if err := s.webPush.RemoveSubscriptionsByEndpoint(req.Endpoint); err != nil {
		return err
	}
	return s.writeJSON(w, newSuccessResponse())
}

func (s *Server) publishToWebPushEndpoints(v *visitor, m *model.Message) {
	subscriptions, err := s.webPush.SubscriptionsForTopic(m.Topic)
	if err != nil {
		logvm(v, m).Err(err).With(v, m).Warn("Unable to publish web push messages")
		return
	}
	log.Tag(tagWebPush).With(v, m).Debug("Publishing web push message to %d subscribers", len(subscriptions))
	payload, err := json.Marshal(newWebPushPayload(fmt.Sprintf("%s/%s", s.config.BaseURL, m.Topic), m.ForJSON()))
	if err != nil {
		log.Tag(tagWebPush).Err(err).With(v, m).Warn("Unable to marshal expiring payload")
		return
	}
	for _, subscription := range subscriptions {
		if err := s.sendWebPushNotification(subscription, payload, v, m); err != nil {
			log.Tag(tagWebPush).Err(err).With(v, m, subscription).Warn("Unable to publish web push message")
		}
	}
}

func (s *Server) pruneAndNotifyWebPushSubscriptions() {
	if s.config.WebPushPublicKey == "" {
		return
	}
	go func() {
		if err := s.pruneAndNotifyWebPushSubscriptionsInternal(); err != nil {
			log.Tag(tagWebPush).Err(err).Warn("Unable to prune or notify web push subscriptions")
		}
	}()
}

func (s *Server) pruneAndNotifyWebPushSubscriptionsInternal() error {
	// Expire old subscriptions
	if err := s.webPush.RemoveExpiredSubscriptions(s.config.WebPushExpiryDuration); err != nil {
		return err
	}
	// Notify subscriptions that will expire soon
	subscriptions, err := s.webPush.SubscriptionsExpiring(s.config.WebPushExpiryWarningDuration)
	if err != nil {
		return err
	} else if len(subscriptions) == 0 {
		return nil
	}
	payload, err := json.Marshal(newWebPushSubscriptionExpiringPayload())
	if err != nil {
		return err
	}
	warningSent := make([]*wpush.Subscription, 0)
	for _, subscription := range subscriptions {
		if err := s.sendWebPushNotification(subscription, payload); err != nil {
			log.Tag(tagWebPush).Err(err).With(subscription).Warn("Unable to publish expiry imminent warning")
			continue
		}
		warningSent = append(warningSent, subscription)
	}
	if err := s.webPush.MarkExpiryWarningSent(warningSent); err != nil {
		return err
	}
	log.Tag(tagWebPush).Debug("Expired old subscriptions and published %d expiry imminent warnings", len(subscriptions))
	return nil
}

func (s *Server) sendWebPushNotification(sub *wpush.Subscription, message []byte, contexters ...log.Contexter) error {
	log.Tag(tagWebPush).With(sub).With(contexters...).Debug("Sending web push message")
	payload := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			Auth:   sub.Auth,
			P256dh: sub.P256dh,
		},
	}
	resp, err := webpush.SendNotification(message, payload, &webpush.Options{
		Subscriber:      s.config.WebPushEmailAddress,
		VAPIDPublicKey:  s.config.WebPushPublicKey,
		VAPIDPrivateKey: s.config.WebPushPrivateKey,
		Urgency:         webpush.UrgencyHigh, // iOS requires this to ensure delivery
		TTL:             s.webPushTTLSeconds(),
	})
	if err != nil {
		// Transport-level failure (DNS, TLS, connection reset, ...). The subscription itself may
		// still be perfectly fine, so we must NOT remove it -- doing so used to permanently kill
		// delivery after a single transient network hiccup, with no way to recover until the user
		// re-opened the app.
		log.Tag(tagWebPush).With(sub).With(contexters...).Err(err).Debug("Unable to publish web push message (transport error), keeping subscription")
		return err
	}
	if resp.Body != nil {
		defer resp.Body.Close()
	}
	if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
		// A successful delivery proves the subscription is alive. Refresh it so that clients which
		// cannot re-register themselves (iOS PWA, no Periodic Background Sync) are not expired by
		// RemoveExpiredSubscriptions just because the user never opened the app again.
		if err := s.webPush.TouchSubscriptions([]string{sub.Endpoint}); err != nil {
			log.Tag(tagWebPush).With(sub).With(contexters...).Err(err).Warn("Unable to refresh web push subscription")
		}
		return nil
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		log.Tag(tagWebPush).With(sub).With(contexters...).Field("response_code", resp.StatusCode).Debug("Push service rate limited, keeping subscription")
		return errHTTPInternalErrorWebPushUnableToPublish.With(sub).With(contexters...)
	}
	if webPushSubscriptionIsGone(resp.StatusCode) {
		log.Tag(tagWebPush).With(sub).With(contexters...).Field("response_code", resp.StatusCode).Debug("Unable to publish web push message, removing endpoint")
		if err := s.webPush.RemoveSubscriptionsByEndpoint(sub.Endpoint); err != nil {
			return err
		}
		return errHTTPInternalErrorWebPushUnableToPublish.With(sub).With(contexters...)
	}
	// Transient push service failure (5xx, ...): keep the subscription and retry on next publish.
	log.Tag(tagWebPush).With(sub).With(contexters...).Field("response_code", resp.StatusCode).Debug("Unable to publish web push message, unexpected response")
	return errHTTPInternalErrorWebPushUnableToPublish.With(sub).With(contexters...)
}

// webPushTTLSeconds returns the delivery time-to-live for web push messages. It falls back to
// cache-duration and then to 4 weeks, because a TTL of 0 drops the message as soon as the device
// is not reachable at publish time.
func (s *Server) webPushTTLSeconds() int {
	if s.config.WebPushTTL > 0 {
		return int(s.config.WebPushTTL.Seconds())
	}
	if s.config.CacheDuration > 0 {
		return int(s.config.CacheDuration.Seconds())
	}
	return defaultWebPushTTLSeconds
}
