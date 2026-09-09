// ScottySpeaks is local-only. Keep the former cloud-auth surface explicit so
// callers cannot mistake a disabled operation for a successful one.
export const NEON_AUTH_URL = "";
export const authClient = null;
export type SocialProvider = "google";

export interface AuthError {
  message: string;
}

export interface AuthOperationResult {
  data: null;
  error: AuthError | null;
}

const AUTH_UNAVAILABLE_RESULT: AuthOperationResult = {
  data: null,
  error: { message: "Authentication is not available in this local-only build." },
};

export function isWithinGracePeriod() {
  return false;
}

export async function signOut(): Promise<AuthOperationResult> {
  return { data: null, error: null };
}

export async function signIn(_email?: string, _password?: string): Promise<AuthOperationResult> {
  return AUTH_UNAVAILABLE_RESULT;
}

export async function signInWithSocial(_provider: SocialProvider): Promise<AuthOperationResult> {
  return AUTH_UNAVAILABLE_RESULT;
}

export function updateLastSignInTime() {
  // No-op
}

export async function resetPassword(
  _password: string,
  _token: string
): Promise<AuthOperationResult> {
  return AUTH_UNAVAILABLE_RESULT;
}

export async function requestPasswordReset(_email: string): Promise<AuthOperationResult> {
  return AUTH_UNAVAILABLE_RESULT;
}

export function withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}
