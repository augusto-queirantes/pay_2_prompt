// A stand-in for the JustiFi API, for e2e runs and local demos. It speaks just
// enough of the API for the paywall service, plus a fake hosted checkout page.
//
//   bun scripts/fake-justifi.ts            # listens on $PORT, default 4999
//
// Test hooks:
//   POST /__test/pay/:id      mark a checkout completed
//   POST /__test/expire/:id   mark a checkout expired
//   GET  /__test/stats        request counters

type Status = "created" | "attempted" | "completed" | "expired";

export interface FakeJustifi {
  url: string;
  stop(): Promise<void>;
}

export function startFakeJustifi(port = 0): FakeJustifi {
  const checkouts = new Map<string, { status: Status; amount: number; description: string }>();
  const stats = { tokens: 0, creates: 0, gets: 0 };

  const setStatus = (id: string, status: Status) => {
    const checkout = checkouts.get(id);
    if (!checkout) return Response.json({ error: "not_found" }, { status: 404 });
    checkout.status = status;
    return Response.json({ id, status });
  };

  const authorized = (req: Request) => req.headers.get("authorization")?.startsWith("Bearer ");

  const server = Bun.serve({
    hostname: process.env.HOST || "localhost",
    port,
    routes: {
      "/oauth/token": {
        POST: () => {
          stats.tokens++;
          return Response.json({ access_token: `fake_${crypto.randomUUID()}` });
        },
      },
      "/v1/checkouts": {
        POST: async (req) => {
          if (!authorized(req)) return new Response("unauthorized", { status: 401 });
          if (!req.headers.get("sub-account")) return Response.json({ error: "missing Sub-Account" }, { status: 400 });
          stats.creates++;
          const { amount, description } = (await req.json()) as { amount: number; description: string };
          // Random ids, so a fake restart never collides with rows already in SQLite.
          const id = `cho_fake_${crypto.randomUUID().slice(0, 8)}`;
          checkouts.set(id, { status: "created", amount, description });
          return Response.json({ data: { id, status: "created" } }, { status: 201 });
        },
      },
      "/v1/checkouts/:id": (req) => {
        if (!authorized(req)) return new Response("unauthorized", { status: 401 });
        stats.gets++;
        const checkout = checkouts.get(req.params.id);
        if (!checkout) return Response.json({ error: "not_found" }, { status: 404 });
        const successful_payment_id = checkout.status === "completed" ? `py_fake_${req.params.id}` : null;
        return Response.json({ data: { id: req.params.id, status: checkout.status, successful_payment_id } });
      },
      "/hosted-checkout/:id": (req) => {
        const checkout = checkouts.get(req.params.id);
        if (!checkout) return new Response("Unknown checkout", { status: 404 });
        const body =
          checkout.status === "completed"
            ? "<p>Paid. Go back to your agent and ask it to try again.</p>"
            : `<form method="post" action="/hosted-checkout/${req.params.id}/pay"><button>Pay (fake)</button></form>`;
        return new Response(
          `<!doctype html><title>Fake checkout</title><h1>${escapeHtml(checkout.description)}</h1>` +
            `<p>$${(checkout.amount / 100).toFixed(2)} · ${checkout.status}</p>${body}`,
          { headers: { "Content-Type": "text/html" } },
        );
      },
      "/hosted-checkout/:id/pay": {
        POST: (req) => {
          setStatus(req.params.id, "completed");
          return Response.redirect(`/hosted-checkout/${req.params.id}`, 303);
        },
      },
      "/__test/pay/:id": { POST: (req) => setStatus(req.params.id, "completed") },
      "/__test/expire/:id": { POST: (req) => setStatus(req.params.id, "expired") },
      "/__test/stats": () => Response.json(stats),
    },
    fetch: () => new Response("not found", { status: 404 }),
  });

  return { url: server.url.href.replace(/\/$/, ""), stop: () => server.stop(true) };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

if (import.meta.main) {
  const fake = startFakeJustifi(Number(process.env.PORT || 4999));
  console.log(`fake JustiFi listening on ${fake.url}`);
}
