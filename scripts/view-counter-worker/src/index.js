export default {
    async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const slug = url.searchParams.get("slug");
            const ip = request.headers.get("cf-connecting-ip") || "anonymous";

            if (!slug) {
                return withCors(new Response("Missing slug", { status: 400 }), request);
            }

            const sessionKey = `session:${slug}:${ip}`;
            const viewKey = `view:${slug}`;

            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: corsHeaders(request)
                });
            }

            if (request.method === "POST") {
                const alreadyViewed = await env.VIEW_COUNTER.get(sessionKey);
                const current = parseInt((await env.VIEW_COUNTER.get(viewKey)) || "0", 10);

                if (!alreadyViewed) {
                    await env.VIEW_COUNTER.put(viewKey, (current + 1).toString());
                    await env.VIEW_COUNTER.put(sessionKey, "1", { expirationTtl: 86400 }); // 24h
                    return withCors(json({ views: current + 1 }), request);
                } else {
                    return withCors(json({ views: current }), request);
                }
            }

            if (request.method === "GET") {
                const current = parseInt((await env.VIEW_COUNTER.get(viewKey)) || "0", 10);
                return withCors(json({ views: current }), request);
            }

            return withCors(new Response("Method Not Allowed", { status: 405 }), request);
        } catch (err) {
            return withCors(new Response(`Worker Error: ${err.message}`, { status: 500 }), request);
        }
    }
};

function json(data) {
    return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
    });
}

function withCors(res, request) {
    const headers = corsHeaders(request);
    for (const [k, v] of Object.entries(headers)) {
        res.headers.set(k, v);
    }
    return res;
}

function corsHeaders(request) {
    const origin = request.headers.get("Origin");
    const allowedOrigin = "https://kvnyng.com"; // 👈 your production domain

    return {
        "Access-Control-Allow-Origin": origin === allowedOrigin ? origin : "",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
    };
}