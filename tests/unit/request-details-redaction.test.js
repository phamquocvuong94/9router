import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRequestDetails: vi.fn(),
}));

vi.mock("@/lib/usageDb", () => mocks);

describe("request-details API payloads", () => {
  it("returns complete request and response payloads", async () => {
    const detail = {
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    };
    mocks.getRequestDetails.mockResolvedValueOnce({
      details: [detail],
      pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
    });

    const { GET } = await import("@/app/api/usage/request-details/route.js");
    const response = await GET(new Request("http://localhost/api/usage/request-details"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.details[0]).toEqual(detail);
    expect(body.details[0].request.messages[0].content).toBe("secret prompt");
    expect(body.details[0].response.content).toBe("secret answer");
    expect(body.details[0].request).not.toEqual({ redacted: true });
  });

  it("keeps empty details and metadata intact", async () => {
    mocks.getRequestDetails.mockResolvedValueOnce({
      details: [],
      pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
    });

    const { GET } = await import("@/app/api/usage/request-details/route.js");
    const response = await GET(new Request("http://localhost/api/usage/request-details"));
    const body = await response.json();

    expect(body.details).toEqual([]);
    expect(body.pagination.totalItems).toBe(0);
  });
});
