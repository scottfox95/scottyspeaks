// Stub: ScottySpeaks has no cloud auth — always "signed in" as local user
export function useAuth() {
  return {
    isSignedIn: false,
    isLoaded: true,
    session: null,
    user: null,
  };
}
