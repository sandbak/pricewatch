import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../api.js";

const SUPPORTED_DOMAINS = ["ah.nl", "bol.com", "amazon.nl", "plus.nl"];

function isSupportedUrl(value) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    return SUPPORTED_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export default function ProductForm({ product, onClose }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const isEditing = !!product;

  const [url, setUrl] = useState(product?.url || "");
  const [label, setLabel] = useState(product?.label || "");
  const [targetPrice, setTargetPrice] = useState(
    product?.targetPrice != null ? String(product.targetPrice) : ""
  );
  const [priceType, setPriceType] = useState(product?.priceType || "regular");
  const [error, setError] = useState(null);

  // Auto-detect AH bonus
  useEffect(() => {
    if (url.includes("ah.nl") && !isEditing) {
      setPriceType("bonus");
    }
  }, [url, isEditing]);

  const saveMutation = useMutation({
    mutationFn: (data) =>
      isEditing ? api.updateProduct(product.id, data) : api.addProduct(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      onClose();
    },
    onError: (err) => setError(err.message),
  });

  function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    if (!url.trim()) {
      setError("URL is required");
      return;
    }
    if (!isSupportedUrl(url.trim())) {
      setError(
        `This shop is not supported yet. Please use a product URL from ${SUPPORTED_DOMAINS.join(", ")}.`
      );
      return;
    }
    if (!label.trim()) {
      setError("Label is required");
      return;
    }
    const price = parseFloat(targetPrice);
    if (isNaN(price) || price <= 0) {
      setError("Target price must be a positive number");
      return;
    }

    saveMutation.mutate({
      url: url.trim(),
      label: label.trim(),
      targetPrice: price,
      priceType,
    });
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold mb-4">
          {isEditing ? "Edit Product" : "Add Product"}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              URL
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.ah.nl/producten/..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="mt-1 text-xs text-gray-500">
              Supported shops: {SUPPORTED_DOMAINS.join(", ")}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Label
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Oat milk"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Target Price (€)
            </label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={targetPrice}
              onChange={(e) => setTargetPrice(e.target.value)}
              placeholder="2.50"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Price Type
            </label>
            <select
              value={priceType}
              onChange={(e) => setPriceType(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="regular">Regular</option>
              <option value="bonus">Bonus</option>
            </select>
            {url.includes("ah.nl") && priceType === "bonus" && (
              <p className="mt-1 text-xs text-yellow-400">
                AH bonus price detected — tracking bonus price automatically
              </p>
            )}
          </div>

          {error && (
            <div className="bg-red-900/40 border border-red-800 text-red-300 text-sm rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saveMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              {saveMutation.isPending
                ? "Saving..."
                : isEditing
                ? "Save Changes"
                : "Add Product"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
