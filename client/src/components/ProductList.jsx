import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api.js";
import { Plus, Pencil, Trash2, ExternalLink, RefreshCw } from "lucide-react";
import ProductForm from "./ProductForm.jsx";
import shops from "../../../shared/shops.json";

function getStoreName(url) {
  if (!url) return "—";
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    const shop = shops.find(
      ({ domain }) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    return shop?.name || hostname.split(".")[0];
  } catch {
    return "—";
  }
}

function formatPrice(price) {
  if (price == null) return "—";
  return `€${Number(price).toFixed(2).replace(".", ",")}`;
}

function getPromotionDeal(promotion) {
  if (!promotion) return null;
  if (promotion.unitPrice != null) return { price: promotion.unitPrice, unitLabel: "stuk" };
  if (promotion.totalPrice != null) return { price: promotion.totalPrice, unitLabel: null };
  if (promotion.newPrice != null) return { price: promotion.newPrice, unitLabel: null };
  return null;
}

function timeAgo(dateStr) {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function ProductList() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [editingProduct, setEditingProduct] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [isCheckingNow, setIsCheckingNow] = useState(false);
  const [checkNowMessage, setCheckNowMessage] = useState(null);
  const checkPollRef = useRef(null);

  const { data: products, isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: api.getProducts,
  });

  useEffect(() => {
    return () => {
      if (checkPollRef.current) {
        clearInterval(checkPollRef.current);
        checkPollRef.current = null;
      }
    };
  }, []);

  const deleteMutation = useMutation({
    mutationFn: (id) => api.deleteProduct(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });

  const checkNowMutation = useMutation({
    mutationFn: api.checkNow,
    onMutate: () => {
      setCheckNowMessage(null);
      setIsCheckingNow(true);
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["products"] });

      const jobId = data?.jobId;
      if (!jobId) {
        setCheckNowMessage({
          type: "info",
          text:
            data?.message ||
            (data?.source === "cron"
              ? "A scheduled check is already running. Try again shortly."
              : "Check already running."),
        });
        setIsCheckingNow(false);
        return;
      }

      let attempts = 0;
      const maxAttempts = 120; // ~10 minutes at 5s interval
      let finished = false;
      if (checkPollRef.current) {
        clearInterval(checkPollRef.current);
      }

      const pollJob = async () => {
        attempts += 1;
        const job = await api.getCheckNowJob(jobId).catch(() => null);
        await queryClient.invalidateQueries({ queryKey: ["products"] });

        const done = job && (job.status === "done" || job.status === "failed");
        if (done || attempts >= maxAttempts) {
          finished = true;
          if (checkPollRef.current) {
            clearInterval(checkPollRef.current);
            checkPollRef.current = null;
          }
          setIsCheckingNow(false);

          if (!job) {
            setCheckNowMessage({ type: "error", text: "Unable to read check status." });
            return;
          }

          if (job.status === "failed") {
            setCheckNowMessage({ type: "error", text: job.error || "Check failed." });
            return;
          }

          const checked = job.result?.checked ?? 0;
          const failed = job.result?.failed ?? 0;
          if (failed > 0) {
            const firstFailure = job.result?.results?.find((r) => !r.ok);
            const firstError = firstFailure
              ? `${firstFailure.label || firstFailure.id || "Product"}: ${firstFailure.error}`
              : null;
            setCheckNowMessage({
              type: "error",
              text: `Checked ${checked} product(s), ${failed} failed${firstError ? `: ${firstError}` : "."}`,
            });
          } else {
            setCheckNowMessage({ type: "success", text: `Checked ${checked} product(s).` });
          }
        }
      };

      await pollJob();
      if (!finished && !checkPollRef.current) {
        checkPollRef.current = setInterval(pollJob, 5000);
      }
    },
    onError: (err) => {
      if (checkPollRef.current) {
        clearInterval(checkPollRef.current);
        checkPollRef.current = null;
      }
      setCheckNowMessage({ type: "error", text: err.message || "Check failed." });
      setIsCheckingNow(false);
    },
  });

  function handleDelete(id, label) {
    if (window.confirm(`Delete "${label}"?`)) {
      deleteMutation.mutate(id);
    }
  }

  function handleEdit(product) {
    setEditingProduct(product);
    setShowForm(true);
  }

  function handleAdd() {
    setEditingProduct(null);
    setShowForm(true);
  }

  function handleCloseForm() {
    setShowForm(false);
    setEditingProduct(null);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Tracked Products</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => checkNowMutation.mutate()}
            disabled={!!isCheckingNow || checkNowMutation.isPending || !products?.length}
            className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed text-gray-100 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <RefreshCw
              size={16}
              className={isCheckingNow || checkNowMutation.isPending ? "animate-spin" : ""}
            />
            {isCheckingNow || checkNowMutation.isPending ? "Checking..." : "Check now"}
          </button>
          <button
            onClick={handleAdd}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            <Plus size={16} />
            Add Product
          </button>
        </div>
      </div>

      {checkNowMutation.isError && (
        <div className="mb-4 bg-red-900/40 border border-red-800 text-red-300 text-sm rounded-lg px-3 py-2">
          {checkNowMutation.error.message}
        </div>
      )}

      {checkNowMessage && (
        <div
          className={`mb-4 text-sm rounded-lg px-3 py-2 border ${
            checkNowMessage.type === "success"
              ? "bg-green-900/40 border-green-800 text-green-300"
              : checkNowMessage.type === "info"
                ? "bg-blue-900/40 border-blue-800 text-blue-300"
                : "bg-red-900/40 border-red-800 text-red-300"
          }`}
        >
          {checkNowMessage.text}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="bg-gray-900 border border-gray-800 rounded-lg p-4 animate-pulse"
            >
              <div className="flex gap-4">
                <div className="h-4 bg-gray-800 rounded w-1/4" />
                <div className="h-4 bg-gray-800 rounded w-1/6" />
                <div className="h-4 bg-gray-800 rounded w-1/6" />
                <div className="h-4 bg-gray-800 rounded w-1/6" />
              </div>
            </div>
          ))}
        </div>
      ) : !products || products.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-12 text-center">
          <p className="text-gray-400">
            No products yet. Add your first product!
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-800">
                <th className="pb-3 pr-4 font-medium">Label</th>
                <th className="pb-3 pr-4 font-medium">Store</th>
                <th className="pb-3 pr-4 font-medium">Price</th>
                <th className="pb-3 pr-4 font-medium">Target</th>
                <th className="pb-3 pr-4 font-medium">Status</th>
                <th className="pb-3 pr-4 font-medium">Last Checked</th>
                <th className="pb-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const promoDeal = getPromotionDeal(p.promotion);
                const effectivePrice =
                  promoDeal?.price != null && p.lastPrice != null
                    ? Math.min(p.lastPrice, promoDeal.price)
                    : promoDeal?.price ?? p.lastPrice;
                const isBelow =
                  effectivePrice != null &&
                  p.targetPrice != null &&
                  effectivePrice <= p.targetPrice;
                return (
                  <tr
                    key={p.id}
                    className="border-b border-gray-800/50 hover:bg-gray-900/50"
                  >
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-100">
                          {p.label}
                        </span>
                        {p.url && (
                          <a
                            href={p.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-500 hover:text-gray-300"
                          >
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-gray-300">
                      {getStoreName(p.url)}
                    </td>
                    <td className="py-3 pr-4 font-mono text-gray-200">
                      {formatPrice(p.lastPrice)}
                      {p.promotion && (
                        <div className="text-xs text-yellow-400 mt-0.5">
                          {p.promotion.label}
                          {promoDeal && (
                            <>
                              {" → "}{formatPrice(promoDeal.price)}
                              {promoDeal.unitLabel ? `/${promoDeal.unitLabel}` : ""}
                            </>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4 font-mono text-gray-400">
                      {formatPrice(p.targetPrice)}
                    </td>
                    <td className="py-3 pr-4">
                      {p.lastPrice != null ? (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            isBelow
                              ? "bg-green-900/60 text-green-300"
                              : "bg-gray-800 text-gray-400"
                          }`}
                        >
                          {isBelow ? "Below target" : "Above target"}
                        </span>
                      ) : (
                        <span className="text-gray-500 text-xs">
                          No data yet
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-gray-400 text-xs">
                      {timeAgo(p.lastChecked)}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleEdit(p)}
                          className="p-1.5 rounded-md hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
                          title="Edit"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => handleDelete(p.id, p.label)}
                          className="p-1.5 rounded-md hover:bg-red-900/40 text-gray-400 hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <ProductForm
          product={editingProduct}
          onClose={handleCloseForm}
        />
      )}
    </div>
  );
}
