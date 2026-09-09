export interface LocalUsage {
  plan: "local";
  status: "active";
  isPastDue: false;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  isSubscribed: false;
  isTrial: false;
  trialDaysLeft: null;
  currentPeriodEnd: null;
  billingInterval: null;
  resetAt: string;
  isOverLimit: false;
  isApproachingLimit: false;
  hasLoaded: true;
  checkoutLoading: false;
  openCheckout: (
    billingInterval?: "monthly" | "annual"
  ) => Promise<{ success: false; error: string }>;
  openBillingPortal: () => Promise<{ success: false; error: string }>;
}

const SUBSCRIPTIONS_UNAVAILABLE = {
  success: false,
  error: "Subscriptions are not available in this local-only build.",
} as const;

// ScottySpeaks is local-only and does not meter usage.
export function useUsage(): LocalUsage {
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
    isApproachingLimit: false,
    hasLoaded: true,
    checkoutLoading: false,
    openCheckout: async (_billingInterval?: "monthly" | "annual") => SUBSCRIPTIONS_UNAVAILABLE,
    openBillingPortal: async () => SUBSCRIPTIONS_UNAVAILABLE,
  };
}
