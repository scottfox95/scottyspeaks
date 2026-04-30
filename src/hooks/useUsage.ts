// Stub: ScottySpeaks is local-only — no usage limits
export function useUsage() {
  return {
    plan: "local",
    status: "active",
    isPastDue: false,
    wordsUsed: 0,
    wordsRemaining: Infinity,
    limit: Infinity,
    isSubscribed: false,
    isTrial: false,
    trialDaysLeft: null,
    currentPeriodEnd: null,
    billingInterval: null,
    resetAt: "",
    isOverLimit: false,
    hasLoaded: true,
    openCheckout: () => {},
  };
}
