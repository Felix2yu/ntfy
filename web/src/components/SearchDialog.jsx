import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Stack,
  Typography,
  Card,
  CardContent,
  CircularProgress,
  Box,
} from "@mui/material";
import * as React from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import SearchIcon from "@mui/icons-material/Search";
import api from "../app/Api";
import config from "../app/config";
import { formatDateTime } from "../app/utils";
import { usePrefCache } from "./PrefCache";

const SearchDialog = (props) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { dateFormat, timeFormat } = usePrefCache();
  const { open, onClose, topics } = props;
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [priority, setPriority] = useState(0);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const params = {
        q: query.trim(),
        topic: topic || undefined,
        since: since ? Math.floor(new Date(since).getTime() / 1000) : undefined,
        until: until ? Math.floor(new Date(until).getTime() / 1000) : undefined,
        priority: priority || undefined,
        limit: 50,
      };
      const messages = await api.search(config.base_url, params);
      setResults(messages);
    } catch (e) {
      console.error("[SearchDialog] Search failed:", e);
      setError(e.message || "Search failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResultClick = (message) => {
    navigate(`/${message.topic}`);
    onClose();
  };

  const handleClose = () => {
    setQuery("");
    setTopic("");
    setSince("");
    setUntil("");
    setPriority(0);
    setResults(null);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="md" fullWidth>
      <DialogTitle>{t("search_dialog_title", "Search Notifications")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            autoFocus
            label={t("search_dialog_query", "Search keyword")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            fullWidth
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
          <Stack direction="row" spacing={2}>
            <FormControl fullWidth>
              <InputLabel>{t("search_dialog_topic", "Topic (optional)")}</InputLabel>
              <Select
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                label={t("search_dialog_topic", "Topic (optional)")}
              >
                <MenuItem value="">
                  <em>{t("search_dialog_all_topics", "All topics")}</em>
                </MenuItem>
                {topics?.map((t) => (
                  <MenuItem key={t} value={t}>
                    {t}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel>{t("search_dialog_priority", "Priority (optional)")}</InputLabel>
              <Select
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                label={t("search_dialog_priority", "Priority (optional)")}
              >
                <MenuItem value={0}>{t("search_dialog_any_priority", "Any")}</MenuItem>
                <MenuItem value={1}>1 - Min</MenuItem>
                <MenuItem value={2}>2 - Low</MenuItem>
                <MenuItem value={3}>3 - Default</MenuItem>
                <MenuItem value={4}>4 - High</MenuItem>
                <MenuItem value={5}>5 - Max</MenuItem>
              </Select>
            </FormControl>
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField
              label={t("search_dialog_since", "Since (optional)")}
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              label={t("search_dialog_until", "Until (optional)")}
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
          </Stack>

          {error && (
            <Typography color="error" variant="body2">
              {error}
            </Typography>
          )}

          {loading && (
            <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
              <CircularProgress />
            </Box>
          )}

          {results && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {t("search_dialog_results_count", { count: results.length }, "{{count}} results found")}
              </Typography>
              {results.length === 0 ? (
                <Typography color="text.secondary">
                  {t("search_dialog_no_results", "No results found")}
                </Typography>
              ) : (
                <Stack spacing={1} sx={{ maxHeight: 400, overflow: "auto" }}>
                  {results.map((msg) => (
                    <Card
                      key={msg.id}
                      sx={{ cursor: "pointer", "&:hover": { bgcolor: "action.hover" } }}
                      onClick={() => handleResultClick(msg)}
                    >
                      <CardContent sx={{ py: 1, "&:last-child": { pb: 1 } }}>
                        <Typography variant="caption" color="text.secondary">
                          [{msg.topic}] {formatDateTime(msg.time, dateFormat, timeFormat)}
                        </Typography>
                        {msg.title && (
                          <Typography variant="subtitle2" sx={{ fontWeight: "bold" }}>
                            {msg.title}
                          </Typography>
                        )}
                        <Typography variant="body2" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {msg.message}
                        </Typography>
                      </CardContent>
                    </Card>
                  ))}
                </Stack>
              )}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>{t("search_dialog_cancel", "Cancel")}</Button>
        <Button onClick={handleSearch} variant="contained" startIcon={<SearchIcon />} disabled={!query.trim() || loading}>
          {t("search_dialog_search", "Search")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default SearchDialog;
