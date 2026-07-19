import {
  __buildCursorHeaders,
  callCursorResponses,
  extractCursorModelIds,
} from "../src/upstream/cursor-api";

async function main(): Promise<void> {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    throw new Error("CURSOR_API_KEY is not set");
  }

  const exchange = await fetch(
    "https://api2.cursor.sh/auth/exchange_user_api_key",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );

  if (!exchange.ok) {
    throw new Error(`Cursor API key exchange failed (${exchange.status})`);
  }

  const token = (await exchange.json()) as {
    accessToken?: string;
    refreshToken?: string;
  };

  if (!token.accessToken || !token.refreshToken) {
    throw new Error("Cursor API key exchange returned incomplete credentials");
  }

  const account: any = {
    token: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      email: "cursor-api-key",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      accountUuid: "cursor-api-key",
      provider: "cursor",
    },
    deviceId: "cursor-api-key",
    accountUuid: "cursor-api-key",
    provider: "cursor",
  };

  const config: any = {
    cloaking: { cursor: {} },
    timeouts: {
      "messages-ms": 120_000,
      "stream-messages-ms": 600_000,
    },
  };

  const modelsResponse = await fetch(
    "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels",
    {
      method: "POST",
      headers: {
        ...__buildCursorHeaders(account, config),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    },
  );

  let modelsPayload: unknown;
  try {
    modelsPayload = await modelsResponse.json();
  } catch {
    modelsPayload = null;
  }

  const modelIds = extractCursorModelIds(modelsPayload);
  const fableModel = modelIds.find(
    (id) => id === "cursor-claude-fable-5-low",
  );
  let generation: {
    model: string;
    status: number;
    completed: boolean;
    returnedOk: boolean;
    bodyBytes: number;
    eventTypes: string[];
    sample: string;
  } | null = null;

  if (fableModel) {
    const response = await callCursorResponses({
      body: {
        model: fableModel,
        input: "Reply exactly OK.",
        stream: true,
      },
      account,
      config,
    } as any);
    const body = await response.text();
    generation = {
      model: fableModel,
      status: response.status,
      completed: body.includes("response.completed"),
      returnedOk: /(?:delta|text)"?\s*:\s*"?OK\b/.test(body),
      bodyBytes: Buffer.byteLength(body),
      eventTypes: Array.from(
        new Set(
          Array.from(body.matchAll(/"type":"([^"]+)"/g), (match) => match[1]),
        ),
      ),
      sample: body.slice(0, 800),
    };
  }

  console.log(
    JSON.stringify({
      exchangeStatus: exchange.status,
      modelsStatus: modelsResponse.status,
      modelCount: modelIds.length,
      fableModels: modelIds.filter((id) => id.includes("fable")),
      generation,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
