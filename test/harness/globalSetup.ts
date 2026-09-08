import { readResponseBody, ResponseBodyReadError } from "../../src/core/http.js";

export async function setup(): Promise<void> {
  let res: Response;
  try {
    res = await fetch("http://localhost:8008/_matrix/client/versions");
  } catch (error) {
    throw new Error(
      [
        "Synapse not reachable at http://localhost:8008",
        "",
        "  Run 'npm run synapse:up' first.",
        "",
      ].join("\n"),
      { cause: error },
    );
  }

  let responseText: string;
  try {
    const body = await readResponseBody(res);
    responseText = new TextDecoder().decode(body.bytes);
  } catch (error) {
    const partial = error instanceof ResponseBodyReadError
      ? new TextDecoder().decode(error.bytes)
      : "";
    throw new Error(
      `Synapse versions response read failed; complete body before failure:\n${partial}`,
      { cause: error },
    );
  }
  if (!res.ok) {
    throw new Error(
      `Synapse versions request returned HTTP ${res.status}; complete response body:\n${responseText}`,
    );
  }
  let body: { versions?: string[] };
  try {
    body = JSON.parse(responseText) as { versions?: string[] };
  } catch (error) {
    throw new Error(`Synapse versions response is not JSON; complete response body:\n${responseText}`, {
      cause: error,
    });
  }
  if (!body.versions) {
    throw new Error(
      "Synapse responded but response has no versions field — is this a Matrix server?",
    );
  }
}
