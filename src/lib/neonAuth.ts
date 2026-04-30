// Stub: ScottySpeaks has no cloud auth
export const NEON_AUTH_URL = "";
export const authClient = null;
export type SocialProvider = "google";

export function isWithinGracePeriod() {
  return false;
}

export async function signOut() {
  // No-op
}

export async function signIn() {
  // No-op
}

export async function signInWithSocial(_provider: SocialProvider) {
  // No-op
}

export function updateLastSignInTime() {
  // No-op
}

export async function resetPassword() {
  // No-op
}

export async function requestPasswordReset() {
  // No-op
}

export function withSessionRefresh<T>(fn: T): T {
  return fn;
}
