function getPromotionDeal(promotion) {
  if (!promotion) return null;

  if (promotion.unitPrice != null) {
    return {
      price: promotion.unitPrice,
      label: promotion.label,
      unitLabel: "stuk",
    };
  }

  if (promotion.totalPrice != null) {
    return {
      price: promotion.totalPrice,
      label: promotion.label,
      unitLabel: null,
    };
  }

  if (promotion.newPrice != null) {
    return {
      price: promotion.newPrice,
      label: promotion.label,
      unitLabel: null,
    };
  }

  return null;
}

function getEffectivePrice(scrapeResult) {
  const promoDeal = getPromotionDeal(scrapeResult.promotion);
  if (promoDeal?.price != null && scrapeResult.price != null) {
    return Math.min(scrapeResult.price, promoDeal.price);
  }
  return promoDeal?.price ?? scrapeResult.price ?? null;
}

module.exports = { getPromotionDeal, getEffectivePrice };
