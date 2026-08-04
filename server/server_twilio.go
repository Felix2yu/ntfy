package server

import (
	"heckel.io/ntfy/v2/metrics"
	"heckel.io/ntfy/v2/model"
	"heckel.io/ntfy/v2/twilio"
	"heckel.io/ntfy/v2/user"
	"heckel.io/ntfy/v2/util"
)

// convertPhoneNumber checks if the given phone number is verified for the given user, and if so, returns the verified
// phone number. It also converts a boolean string ("yes", "1", "true") to the first verified phone number.
// If the user is anonymous, it will return an error.
func (s *Server) convertPhoneNumber(u *user.User, phoneNumber string) (string, *errHTTP) {
	if u == nil {
		return "", errHTTPBadRequestAnonymousCallsNotAllowed
	}
	phoneNumbers, err := s.userManager.PhoneNumbers(u.ID)
	if err != nil {
		return "", errHTTPInternalError
	} else if len(phoneNumbers) == 0 {
		return "", errHTTPBadRequestPhoneNumberNotVerified
	}
	if toBool(phoneNumber) {
		return phoneNumbers[0], nil
	} else if util.Contains(phoneNumbers, phoneNumber) {
		return phoneNumber, nil
	}
	return "", errHTTPBadRequestPhoneNumberNotVerified
}

// callPhone calls the Twilio API to make a phone call to the given phone number, using the given message.
// Failures will be logged, but not returned to the caller.
func (s *Server) callPhone(v *visitor, m *model.Message, to string) {
	u, sender := v.User(), m.Sender.String()
	if u != nil {
		sender = u.Name
	}
	logvm(v, m).Tag(tagTwilio).Field("twilio_to", to).Info("Making phone call to %s", to)
	err := s.twilio.Call(to, &twilio.CallData{
		Topic:    m.Topic,
		Title:    m.Title,
		Message:  m.Message,
		Priority: m.Priority,
		Tags:     m.Tags,
		Sender:   sender,
	})
	if err != nil {
		logvm(v, m).Tag(tagTwilio).Field("twilio_to", to).Err(err).Warn("Unable to call phone %s: %v", to, err.Error())
		metrics.CallsMadeFailure.Inc()
		return
	}
	metrics.CallsMadeSuccess.Inc()
}
