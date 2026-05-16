import { useAuth } from "@clerk/react";

// Hook that returns an api object with authenticated fetch methods
export function useApi() {
  const { getToken } = useAuth();

  async function request(method, path, body) {
    const token = await getToken();
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "Request failed");
    }
    return res.json();
  }

  return {
    getProducts: () => request("GET", "/products"),
    addProduct: (data) => request("POST", "/products", data),
    updateProduct: (id, data) => request("PUT", `/products/${id}`, data),
    deleteProduct: (id) => request("DELETE", `/products/${id}`),
    getConfig: () => request("GET", "/config"),
    updateConfig: (data) => request("PUT", "/config", data),
    testTelegram: () => request("POST", "/config/test"),
    getStatus: () => request("GET", "/status"),
    checkNow: () => request("POST", "/check-now"),
  };
}
