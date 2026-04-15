export const ACCESS_TOKEN_KEY = "opencom_access_token";
export const REFRESH_TOKEN_KEY = "opencom_refresh_token";
export const ACCESS_TOKEN_REFRESH_EVENT = "opencom-access-token-refresh";
export const MEMBERSHIP_TOKEN_REFRESH_EVENT = "opencom-membership-token-refresh";

let pendingAccessTokenRefreshPromise = null;

function normalizeTokenValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readStoredAuthSession() {
  if (typeof window === "undefined") return null;
  const accessToken = normalizeTokenValue(localStorage.getItem(ACCESS_TOKEN_KEY));
  const refreshToken = normalizeTokenValue(localStorage.getItem(REFRESH_TOKEN_KEY));
  if (!accessToken && !refreshToken) return null;
  return { accessToken, refreshToken };
}

export function writeStoredAuthSession(session) {
  if (typeof window === "undefined") return null;

  const accessToken = normalizeTokenValue(session?.accessToken);
  const refreshToken = normalizeTokenValue(session?.refreshToken);

  if (accessToken) {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  } else {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
  }

  if (refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } else {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }

  if (!accessToken && !refreshToken) return null;
  return { accessToken, refreshToken };
}

export function clearStoredAuthSession() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function dispatchAccessTokenRefresh(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ACCESS_TOKEN_REFRESH_EVENT, { detail }));
}

export function dispatchMembershipTokenRefresh(detail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MEMBERSHIP_TOKEN_REFRESH_EVENT, { detail }),
  );
}

export async function runSingleFlightAccessTokenRefresh(executor) {
  if (pendingAccessTokenRefreshPromise) {
    return pendingAccessTokenRefreshPromise;
  }

  const refreshPromise = Promise.resolve().then(executor);
  pendingAccessTokenRefreshPromise = refreshPromise;

  try {
    return await refreshPromise;
  } finally {
    if (pendingAccessTokenRefreshPromise === refreshPromise) {
      pendingAccessTokenRefreshPromise = null;
    }
  }
}
