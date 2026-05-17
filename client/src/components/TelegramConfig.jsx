import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api.js";
import { Send, Save, CheckCircle, AlertCircle, Search } from "lucide-react";

export default function TelegramConfig() {
  const api = useApi();
  const queryClient = useQueryClient();

  const [botToken, setBotToken] = useState("");
  const [checkInterval, setCheckInterval] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [toast, setToast] = useState(null);

  // Load config
  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ["config"],
    queryFn: api.getConfig,
  });

  // Load status
  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["status"],
    queryFn: api.getStatus,
  });

  // Initialize form state from config (once)
  if (config && !initialized) {
    setBotToken("");
    setCheckInterval(config.checkIntervalMinutes != null ? String(config.checkIntervalMinutes) : "60");
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateConfig({
        botToken: botToken.trim(),
        checkIntervalMinutes: parseInt(checkInterval, 10) || 60,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      showToast("success", "Settings saved successfully");
    },
    onError: (err) => showToast("error", err.message),
  });

  const testMutation = useMutation({
    mutationFn: () => api.testTelegram(),
    onSuccess: () => showToast("success", "Test message sent!"),
    onError: (err) => showToast("error", err.message),
  });

  const discoverMutation = useMutation({
    mutationFn: () => api.discoverTelegramChat({ botToken: botToken.trim() }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      showToast("success", `Telegram chat connected: ${data.chat?.title || data.chat?.chatId}`);
    },
    onError: (err) => showToast("error", err.message),
  });

  function showToast(type, message) {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  }

  function handleSave(e) {
    e.preventDefault();
    saveMutation.mutate();
  }

  const hasBotToken = config?.telegram?.botToken && config.telegram.botToken.length > 0;
  const hasChatId = config?.telegram?.chatId && config.telegram.chatId.length > 0;

  return (
    <div className="space-y-6">
      {/* Toast */}
      {toast && (
        <div
          className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm ${
            toast.type === "success"
              ? "bg-green-900/60 border border-green-800 text-green-300"
              : "bg-red-900/60 border border-red-800 text-red-300"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle size={16} />
          ) : (
            <AlertCircle size={16} />
          )}
          {toast.message}
        </div>
      )}

      {/* Telegram Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Telegram Notifications</h2>

        {configLoading ? (
          <div className="space-y-4 animate-pulse">
            <div className="h-10 bg-gray-800 rounded-lg" />
            <div className="h-10 bg-gray-800 rounded-lg" />
            <div className="h-10 bg-gray-800 rounded-lg" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Bot Token
              </label>
              <input
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={hasBotToken ? "••••••••" : "123456789:ABCdefGHI..."}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              {hasBotToken && !botToken && (
                <p className="mt-1 text-xs text-gray-500">
                  Token is configured. Enter a new value to change it.
                </p>
              )}
            </div>

            <div className="bg-gray-950/60 border border-gray-800 rounded-lg p-4 text-sm text-gray-300 space-y-2">
              <p>
                Telegram chat: {hasChatId ? (
                  <span className="text-green-300 font-medium">connected</span>
                ) : (
                  <span className="text-yellow-300 font-medium">not connected</span>
                )}
              </p>
              <ol className="list-decimal list-inside text-gray-400 space-y-1">
                <li>Paste your bot token above.</li>
                <li>Open your bot in Telegram and send <code className="text-gray-200">/start</code>.</li>
                <li>Click “Find my chat”.</li>
              </ol>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1">
                Check Interval (minutes)
              </label>
              <input
                type="number"
                min="5"
                value={checkInterval}
                onChange={(e) => setCheckInterval(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                type="submit"
                disabled={saveMutation.isPending}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                <Save size={16} />
                {saveMutation.isPending ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                onClick={() => discoverMutation.mutate()}
                disabled={discoverMutation.isPending || (!botToken.trim() && !hasBotToken)}
                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-gray-700"
              >
                <Search size={16} />
                {discoverMutation.isPending ? "Finding..." : "Find my chat"}
              </button>
              <button
                type="button"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending || !hasChatId}
                className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors border border-gray-700"
              >
                <Send size={16} />
                {testMutation.isPending ? "Sending..." : "Send Test Message"}
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Status */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">System Status</h2>

        {statusLoading ? (
          <div className="space-y-3 animate-pulse">
            <div className="h-4 bg-gray-800 rounded w-1/3" />
            <div className="h-4 bg-gray-800 rounded w-1/2" />
            <div className="h-4 bg-gray-800 rounded w-2/3" />
          </div>
        ) : status ? (
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-400">Tracked Products</dt>
              <dd className="text-gray-200 font-medium">
                {status.productCount ?? "—"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Last run attempt</dt>
              <dd className="text-gray-200 font-medium">
                {status.lastRunAt
                  ? new Date(status.lastRunAt).toLocaleString()
                  : "Never"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Last successful check</dt>
              <dd className="text-gray-200 font-medium">
                {status.lastChecked
                  ? new Date(status.lastChecked).toLocaleString()
                  : "Never"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Supported Domains</dt>
              <dd className="text-gray-200 font-medium text-right">
                {status.supportedDomains?.join(", ") || "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="text-gray-500 text-sm">Unable to load status</p>
        )}
      </div>
    </div>
  );
}
