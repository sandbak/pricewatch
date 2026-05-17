#!/usr/bin/env node

const assert = require("node:assert/strict");

const { getPromotionDeal, getEffectivePrice } = require("../lib/pricing");
const { buildPriceAlertMessage } = require("../telegram");

const product = {
  label: "Smoke test product",
  targetPrice: 2.5,
  url: "https://example.com/product",
};

function assertNoBrokenPromoFormatting(message) {
  assert.equal(message.includes("undefined"), false, "message must not contain undefined");
  assert.equal(message.includes("—/stuk"), false, "message must not contain missing /stuk price");
  assert.equal(message.includes("— / stuk"), false, "message must not contain missing / stuk price");
}

function run() {
  // Simple sale: use the actual scraped/current price.
  assert.equal(getEffectivePrice({ price: 2.99, promotion: null }), 2.99);

  // Multi-buy: target compares against effective per-item price.
  const multiBuy = {
    quantity: 2,
    totalPrice: 7,
    unitPrice: 3.5,
    label: "2 voor €7,00",
  };
  assert.deepEqual(getPromotionDeal(multiBuy), {
    price: 3.5,
    label: "2 voor €7,00",
    unitLabel: "stuk",
  });
  assert.equal(getEffectivePrice({ price: 4.89, promotion: multiBuy }), 3.5);

  const multiBuyMessage = buildPriceAlertMessage(
    product,
    { title: product.label, price: 4.89, regularPrice: 4.89, promotion: multiBuy },
    { dealViaPromo: true }
  );
  assert.match(multiBuyMessage, /€3,50 \/ stuk/);
  assert.match(multiBuyMessage, /2 voor €7,00/);
  assertNoBrokenPromoFormatting(multiBuyMessage);

  // Weight/package promo: target compares against the package promo total, not €/kg.
  const packagePromo = {
    quantity: 500,
    unit: "gram",
    totalPrice: 2.49,
    pricePerKg: 4.98,
    label: "500 gram €2,49",
  };
  assert.deepEqual(getPromotionDeal(packagePromo), {
    price: 2.49,
    label: "500 gram €2,49",
    unitLabel: null,
  });
  assert.equal(getEffectivePrice({ price: 3.49, promotion: packagePromo }), 2.49);

  const packageMessage = buildPriceAlertMessage(
    product,
    { title: product.label, price: 3.49, regularPrice: 3.49, promotion: packagePromo },
    { dealViaPromo: true }
  );
  assert.match(packageMessage, /€2,49/);
  assert.match(packageMessage, /500 gram €2,49/);
  assert.equal(packageMessage.includes("/ stuk"), false, "package promo must not be formatted per stuk");
  assertNoBrokenPromoFormatting(packageMessage);

  // Fallback sale promotion shape: use newPrice when no unit/total price exists.
  const salePromo = {
    label: "Actieprijs €1,99",
    originalPrice: 2.49,
    newPrice: 1.99,
  };
  assert.deepEqual(getPromotionDeal(salePromo), {
    price: 1.99,
    label: "Actieprijs €1,99",
    unitLabel: null,
  });
  assert.equal(getEffectivePrice({ price: 2.49, promotion: salePromo }), 1.99);

  console.log("✓ pricing/promotion smoke tests passed");
}

run();
