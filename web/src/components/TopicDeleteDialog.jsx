import * as React from "react";
import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../app/Api";
import subscriptionManager from "../app/SubscriptionManager";
import accountApi from "../app/AccountApi";
import session from "../app/Session";
import config from "../app/config";
import routes from "./routes";
import DialogFooter from "./DialogFooter";

/**
 * Confirmation dialog for retiring ("下架") a server-side topic. Retiring purges all cached
 * messages of the topic on the server and removes it from the /v1/topics list, so it no longer
 * shows up in the "Server Topics" navigation section. This is deliberately distinct from a
 * plain local unsubscribe, which only removes the local subscription record.
 *
 * If `subscription` is given (topic currently subscribed on this device), an option to also
 * unsubscribe locally is offered. After a successful retirement, `onDeleted` is invoked (used
 * to refresh the server topics list).
 */
const TopicDeleteDialog = (props) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { topic, subscription, open, onClose, onDeleted } = props;
  const [alsoUnsubscribe, setAlsoUnsubscribe] = useState(!!subscription);
  const [busy, setBusy] = useState(false);
  const [doneCount, setDoneCount] = useState(null);
  const [error, setError] = useState(null);

  // Reset transient state whenever the dialog is (re)opened for a topic
  useEffect(() => {
    if (open) {
      setAlsoUnsubscribe(!!subscription);
      setBusy(false);
      setDoneCount(null);
      setError(null);
    }
  }, [open, topic, subscription]);

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.deleteTopic(config.base_url, topic);
      if (subscription && alsoUnsubscribe) {
        console.log(`[TopicDeleteDialog] Also unsubscribing locally from ${subscription.id}`);
        await subscriptionManager.remove(subscription);
        if (session.exists() && !subscription.internal) {
          try {
            await accountApi.deleteSubscription(subscription.baseUrl, subscription.topic);
          } catch (e) {
            console.log(`[TopicDeleteDialog] Error removing remote subscription`, e);
          }
        }
        // Reasonable fallback: if the retired topic is open right now, go back to the
        // default (All notifications) view.
        if (location.pathname.endsWith(`/${topic}`)) {
          navigate(routes.app);
        }
      }
      setDoneCount(response.deleted_messages ?? 0);
      setTimeout(() => {
        onDeleted?.();
        onClose();
      }, 1500);
    } catch (e) {
      console.error(`[TopicDeleteDialog] Failed to retire topic ${topic}`, e);
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const statusMessage = () => {
    if (doneCount !== null) return t("server_topic_delete_done", { count: doneCount });
    if (error) {
      const msg = t("server_topic_delete_failed");
      return `${msg}: ${error}`;
    }
    return "";
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("server_topic_delete_title", { topic })}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t("server_topic_delete_description")}</DialogContentText>
        {subscription && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Checkbox
                checked={alsoUnsubscribe}
                disabled={busy || doneCount !== null}
                onChange={(e) => setAlsoUnsubscribe(e.target.checked)}
              />
            }
            label={t("server_topic_delete_also_unsubscribe")}
          />
        )}
        {busy && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress />
          </Box>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }} onClose={() => setError(null)}>
            {t("server_topic_delete_failed")}: {error}
          </Alert>
        )}
      </DialogContent>
      <DialogFooter status={doneCount !== null || error ? statusMessage() : ""}>
        <Button onClick={onClose} disabled={busy}>
          {doneCount !== null ? t("common_close") : t("common_cancel")}
        </Button>
        <Button onClick={handleConfirm} disabled={busy || doneCount !== null} variant="contained" color="error">
          {t("server_topic_delete_confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
};

export default TopicDeleteDialog;
