import { useState } from "react";
import { Show, SignIn, UserButton } from "@clerk/react";
import ProductList from "./components/ProductList.jsx";
import TelegramConfig from "./components/TelegramConfig.jsx";

function App() {
  const [activeTab, setActiveTab] = useState("products");

  return (
    <>
      <Show when="signed-out">
        <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
          <SignIn routing="hash" />
        </div>
      </Show>

      <Show when="signed-in">
        <div className="min-h-screen bg-gray-950 text-gray-100">
          {/* Header */}
          <header className="bg-gray-900 border-b border-gray-800">
            <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
              <h1 className="text-xl font-bold">🛒 Price Watcher</h1>

              <nav className="flex items-center gap-4">
                <div className="flex bg-gray-800 rounded-lg p-1">
                  <button
                    onClick={() => setActiveTab("products")}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      activeTab === "products"
                        ? "bg-gray-700 text-white"
                        : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    Products
                  </button>
                  <button
                    onClick={() => setActiveTab("settings")}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      activeTab === "settings"
                        ? "bg-gray-700 text-white"
                        : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    Settings
                  </button>
                </div>

                <UserButton afterSignOutUrl="/" />
              </nav>
            </div>
          </header>

          {/* Content */}
          <main className="max-w-6xl mx-auto px-4 py-6">
            {activeTab === "products" && <ProductList />}
            {activeTab === "settings" && <TelegramConfig />}
          </main>
        </div>
      </Show>
    </>
  );
}

export default App;
