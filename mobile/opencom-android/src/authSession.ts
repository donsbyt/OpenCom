import type { AuthTokens } from "./types";

let pendingAccessTokenRefreshPromise: Promise<AuthTokens | null> | null = null;
const pendingMembershipTokenRefreshByServerId = new Map<
  string,
  Promise<string | null>
>();

function normalizeTokenValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeAuthTokens(
  input: Partial<AuthTokens> | null | undefined,
): AuthTokens | null {
  const accessToken = normalizeTokenValue(input?.accessToken);
  const refreshToken = normalizeTokenValue(input?.refreshToken);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export function withBearerAuthorization(
  headers: Headers,
  token: string | null | undefined,
) {
  const normalizedToken = normalizeTokenValue(token);
  if (normalizedToken) {
    headers.set("Authorization", `Bearer ${normalizedToken}`);
  }
  return headers;
}

export async function runSingleFlightAccessTokenRefresh(
  executor: () => Promise<AuthTokens | null>,
) {
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

export async function runSingleFlightMembershipTokenRefresh(
  serverId: string,
  executor: () => Promise<string | null>,
) {
  const normalizedServerId = normalizeTokenValue(serverId);
  if (!normalizedServerId) {
    return executor();
  }

  const existing = pendingMembershipTokenRefreshByServerId.get(normalizedServerId);
  if (existing) {
    return existing;
  }

  const refreshPromise = Promise.resolve().then(executor);
  pendingMembershipTokenRefreshByServerId.set(normalizedServerId, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    if (
      pendingMembershipTokenRefreshByServerId.get(normalizedServerId) ===
      refreshPromise
    ) {
      pendingMembershipTokenRefreshByServerId.delete(normalizedServerId);
    }
  }
}
