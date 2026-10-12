import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import type { Role } from "@shared/types";
import { auth } from "../firebase";

interface AuthState {
  user: User | null;
  /** Custom claim request.auth.token.role. Never shown in the interface. */
  role: Role | null;
  isAdmin: boolean;
  loading: boolean;
  /** True after an explicit logout, so guards do not remember the page for whoever signs in next. */
  loggedOut: boolean;
  refreshRole: () => Promise<Role | null>;
  /** After updateProfile: Firebase changes the user object in place, so the screens that show its name
   * (the account menu of the top bar) are told to draw again. */
  refreshProfile: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// A retired "vet" claim reads as no role, so the account goes through the profile completion.
async function readRole(user: User | null, force = false): Promise<Role | null> {
  if (!user) return null;
  const token = await user.getIdTokenResult(force);
  const r = token.claims.role;
  return r === "owner" || r === "admin" ? r : null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [loading, setLoading] = useState(true);
  const [loggedOut, setLoggedOut] = useState(false);
  const [, setProfileTick] = useState(0);

  // User and role are set together so no screen ever sees a signed-in user without its role loaded.
  useEffect(() => onAuthStateChanged(auth, async (u) => {
    const r = await readRole(u).catch(() => null);
    setUser(u);
    setRole(r);
    if (u) setLoggedOut(false);
    setLoading(false);
  }), []);

  // Called after setInitialRole: claims only reach the client with a fresh ID token.
  const refreshRole = useCallback(async () => {
    const r = await readRole(auth.currentUser, true);
    setRole(r);
    return r;
  }, []);

  const refreshProfile = useCallback(() => setProfileTick((t) => t + 1), []);

  const logout = useCallback(() => { setLoggedOut(true); return signOut(auth); }, []);

  return (
    <AuthContext.Provider value={{ user, role, isAdmin: role === "admin", loading, loggedOut, refreshRole, refreshProfile, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Pages behind the research-tools guard; everything else is the owner app, open to any account. */
const ADMIN_PREFIX = "/admin";

/** Where to go after signing in: back to `from` unless it is an admin page and the account is not an admin
 * (`from` may come from another user's session). */
export function landingFor(role: Role, from?: string): string {
  if (!from || from.startsWith("/acceso")) return "/";
  return from.startsWith(ADMIN_PREFIX) && role !== "admin" ? "/" : from;
}
