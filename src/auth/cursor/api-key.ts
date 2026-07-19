import { TokenData } from "../types";
import { decodeJwtPayload } from "../../utils/jwt";

const EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

interface CursorApiKeyExchange {
  accessToken?: string;
  refreshToken?: string;
}

function jwtClaims(accessToken: string): {
  email?: string;
  sub?: string;
  exp?: number;
} {
  try {
    return decodeJwtPayload(accessToken) as {
      email?: string;
      sub?: string;
      exp?: number;
    };
  } catch {
    return {};
  }
}

export async function exchangeCursorApiKey(
  apiKey = process.env.CURSOR_API_KEY,
): Promise<TokenData> {
  if (!apiKey) {
    throw new Error(
      "CURSOR_API_KEY is not set; export it before Cursor API-key login",
    );
  }

  const response = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(
      `Cursor API key exchange failed (${response.status}): ${detail}`,
    );
  }

  const exchanged = (await response.json()) as CursorApiKeyExchange;
  if (!exchanged.accessToken || !exchanged.refreshToken) {
    throw new Error("Cursor API key exchange returned incomplete credentials");
  }

  const claims = jwtClaims(exchanged.accessToken);
  const now = new Date().toISOString();
  return {
    accessToken: exchanged.accessToken,
    refreshToken: exchanged.refreshToken,
    email: claims.email || claims.sub || "cursor-api-key",
    expiresAt: claims.exp
      ? new Date(claims.exp * 1000).toISOString()
      : new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    accountUuid: claims.sub || "cursor-api-key",
    provider: "cursor",
    lastRefreshAt: now,
  };
}
